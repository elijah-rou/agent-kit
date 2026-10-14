#!/usr/bin/env bun
// watchdog: tell the user when an unattended run stops writing its decision log. The run's coordinator can die from
// an auth failure or a usage or session limit, and an agent-run watchdog would die from the same failure, so this is
// a plain script a timer outside any agent runs (`scan`). Agents only register and unregister their run, and read
// `status` to learn whether a timer scans this machine at all.
//
// Layout under the registry directory: `<run>.json` is the registration (format version 1), written only by register
// and unregister; `state/<run>.json` is scan's record of the timestamp it already notified for, written only by scan
// and tied to the registration's `registeredAt`; `last-scan` holds the clock of the newest scan; `notifications.log`
// gets one line per notification. Register, unregister, and scan hold the `.lock` directory while they read and
// write, so overlapping scans cannot both notify and a scan cannot notify for a run unregistered mid-scan. Scan reads
// only the first column of the decision log and never prints, logs, or sends any of its contents. A `last-scan` older
// than the scan age limit reads as stale in `status`: a timer that ran once and died leaves that file frozen.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Minutes past twice the interval before a quiet log counts as stopped: a tick's own run time plus clock slack. */
export const GRACE_MINUTES = 15;
const REGISTRY_VERSION = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
/** Twice the 15-minute timer bootstrap installs: one missed scan is slack, two mean the timer is not running. */
export const MAX_SCAN_AGE_MINUTES = 30;
/** Only the log's tail is read; the newest row is the last one, so this bounds the work without changing the answer. */
const TAIL_BYTES = 64 * 1024;
const TEXT_MAX = 300;
const DESKTOP_TIMEOUT_MS = 10_000;
/** How long register, unregister, and scan wait for the lock before giving up. */
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;
/** A lock this old is broken even when its owner's PID is live, since the PID may have been reused. */
const LOCK_STALE_MS = 5 * 60_000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// The first column log.sh writes: `date -u +%Y-%m-%dT%H:%M:%SZ`.
const LOG_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const NOTIFICATIONS = "notifications.log";
const LAST_SCAN = "last-scan";
const LOCK = ".lock";

const USAGE = `Usage:
  watchdog.ts register --run <id> --log <absolute decision-log tsv> --interval-minutes <n> [--title <text>] [--thread <t3 thread id>] [--replace]
  watchdog.ts unregister --run <id>
  watchdog.ts scan
  watchdog.ts status [--run <id>] [--max-scan-age-minutes <n>]
  watchdog.ts notify --run <id> --message <text>

register, notify, scan, and status also take --now <ISO timestamp>, a test clock.

Registry: $AGENTIC_WATCHDOG_DIR, else $XDG_STATE_HOME/agentic/watchdog, else ~/.local/state/agentic/watchdog.
register refuses a run ID registered for a different log unless --replace; re-registering the same log re-arms it.
scan notifies once per registered run whose log has had no new row, and whose registration is no newer, for twice its
interval plus ${GRACE_MINUTES} minutes, or whose log is missing, and clears that state when the log moves again.
status prints "last-scan<TAB><fresh|stale|never><TAB><time or ->", where stale means older than
--max-scan-age-minutes (default ${MAX_SCAN_AGE_MINUTES}), then "<run><TAB><registered|unregistered|invalid><TAB><fresh|stale|missing
or -><TAB><last activity or -><TAB><notified or ->" per run, and notifies nothing.
Notifications go to the desktop (osascript on macOS, notify-send on Linux when present) and always to
notifications.log in the registry; AGENTIC_WATCHDOG_NOTIFY=log keeps them to the log only.

Exit status: 0 done, 1 failure (register, unregister, notify, or status --run for an unregistered run), 2 usage
error. scan exits 0 unless its usage is wrong.
`;

interface Registration {
	version: typeof REGISTRY_VERSION;
	run: string;
	log: string;
	intervalMinutes: number;
	title?: string;
	thread?: string;
	registeredAt: string;
}
interface ScanState {
	registeredAt: string;
	notifiedFor: string;
}
type Status = "fresh" | "stale" | "missing" | "invalid";
interface ScanLine {
	run: string;
	status: Status;
	notified: boolean;
}
/** A run's state at one moment: what scan would decide, before it notifies. */
interface Assessment {
	status: Exclude<Status, "invalid">;
	/** The later of the newest log row and the registration; absent when the log is missing. */
	since?: Date;
	/** What a notification is for: scan notifies once per key and registration. */
	key: string;
	message: string;
}
type Env = Record<string, string | undefined>;
type Newest = { kind: "missing" } | { kind: "empty" } | { kind: "row"; at: Date };
type Mode = "desktop" | "log";

class UsageError extends Error {}
class Failure extends Error {}

export function registryDir(env: Env): string {
	if (env.AGENTIC_WATCHDOG_DIR) return env.AGENTIC_WATCHDOG_DIR;
	const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
	return join(state, "agentic", "watchdog");
}

/** One line of at most TEXT_MAX characters with no control characters, safe in a TSV cell and a notification. */
function oneLine(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, TEXT_MAX);
}

function iso(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeAtomic(path: string, data: string): void {
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, data, { mode: 0o600 });
	renameSync(tmp, path);
}

function registrationPath(dir: string, run: string): string {
	return join(dir, `${run}.json`);
}
function statePath(dir: string, run: string): string {
	return join(dir, "state", `${run}.json`);
}

/** Whether a lock's owner can no longer release it: its PID has exited, or the lock outlived LOCK_STALE_MS. */
function lockIsStale(lock: string): boolean {
	let ageMs: number;
	try {
		ageMs = Date.now() - statSync(lock).mtimeMs;
	} catch {
		return false; // Released between the failed mkdir and now; the next attempt takes it.
	}
	if (ageMs > LOCK_STALE_MS) return true;
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(join(lock, "owner"), "utf8"), 10);
	} catch {
		return false; // The owner is between its mkdir and writing its PID.
	}
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * Run `body` holding the registry's mkdir lock. Two processes that both find the same stale lock at once can both
 * break it; that needs a crashed holder and two contenders within one poll, and costs at most one duplicate scan.
 */
function withLock<T>(dir: string, body: () => T): T {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, LOCK);
	const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (lockIsStale(lock)) {
			rmSync(lock, { recursive: true, force: true });
			process.stderr.write(`watchdog: removed a stale lock at ${lock}\n`);
			continue;
		}
		if (Date.now() >= deadline) throw new Failure(`another watchdog process has held ${lock} for over ${LOCK_WAIT_MS / 1000} seconds`);
		Bun.sleepSync(LOCK_POLL_MS);
	}
	try {
		writeFileSync(join(lock, "owner"), token, { mode: 0o600 });
		return body();
	} finally {
		let owner: string | undefined;
		try {
			owner = readFileSync(join(lock, "owner"), "utf8");
		} catch {
			// Another process broke the lock as stale; it is theirs now.
		}
		if (owner === token) rmSync(lock, { recursive: true, force: true });
	}
}

function parseRegistration(text: string, run: string): Registration | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	const optional = (key: string) => r[key] === undefined || typeof r[key] === "string";
	if (r.version !== REGISTRY_VERSION || r.run !== run || typeof r.log !== "string" || !isAbsolute(r.log)) return undefined;
	if (typeof r.intervalMinutes !== "number" || !Number.isInteger(r.intervalMinutes) || r.intervalMinutes < 1 || r.intervalMinutes > MAX_INTERVAL_MINUTES) return undefined;
	if (typeof r.registeredAt !== "string" || Number.isNaN(Date.parse(r.registeredAt)) || !optional("title") || !optional("thread")) return undefined;
	return r as unknown as Registration;
}

/** The registration, `undefined` when there is none, or `"invalid"` when the file exists but does not parse. */
function readRegistration(dir: string, run: string): Registration | "invalid" | undefined {
	let text: string;
	try {
		text = readFileSync(registrationPath(dir, run), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return "invalid";
	}
	return parseRegistration(text, run) ?? "invalid";
}

function readState(dir: string, run: string): ScanState | undefined {
	try {
		const value = JSON.parse(readFileSync(statePath(dir, run), "utf8"));
		if (typeof value?.registeredAt === "string" && typeof value?.notifiedFor === "string") return value;
	} catch {
		// No state, or a torn one: either way nothing has been notified for this registration.
	}
	return undefined;
}

/** The newest log.sh timestamp in the log's tail. Reads the first column only, and only from a regular file. */
function newestRow(log: string): Newest {
	try {
		// A FIFO or device would block the open, and with it every later scan.
		if (!statSync(log).isFile()) return { kind: "missing" };
	} catch {
		return { kind: "missing" };
	}
	let fd: number;
	try {
		fd = openSync(log, "r");
	} catch {
		return { kind: "missing" };
	}
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.subarray(0, read).toString("utf8").split("\n");
		if (size > length) lines.shift(); // The first line of a partial tail may be cut mid-row.
		let newest: Date | undefined;
		for (const line of lines) {
			const ts = line.split("\t", 1)[0]!;
			if (!LOG_TS.test(ts)) continue;
			const at = new Date(ts);
			if (!Number.isNaN(at.getTime()) && (newest === undefined || at > newest)) newest = at;
		}
		return newest ? { kind: "row", at: newest } : { kind: "empty" };
	} catch {
		return { kind: "missing" };
	} finally {
		closeSync(fd);
	}
}

function notifyMode(env: Env): Mode {
	const mode = env.AGENTIC_WATCHDOG_NOTIFY;
	if (mode === undefined || mode === "" || mode === "desktop") return "desktop";
	if (mode === "log") return "log";
	throw new UsageError(`AGENTIC_WATCHDOG_NOTIFY must be "log" or "desktop", not ${JSON.stringify(mode)}`);
}

/**
 * The desktop notifier's command, or undefined where there is none. Title and message travel as argv, never inside
 * script text, so no run-supplied string is ever parsed as AppleScript.
 */
export function desktopCommand(platform: NodeJS.Platform, title: string, message: string, which: (name: string) => string | null = Bun.which): [string, string[]] | undefined {
	if (platform === "darwin") {
		return ["osascript", ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", "--", oneLine(message), oneLine(title)]];
	}
	if (platform === "linux") {
		const notifySend = which("notify-send");
		if (notifySend) return [notifySend, ["--app-name=agentic watchdog", "--", oneLine(title), oneLine(message)]];
	}
	return undefined;
}

/** Show the notification on the desktop; a failure goes to stderr, which the timer's log keeps. */
function desktop(title: string, message: string): void {
	const command = desktopCommand(process.platform, title, message);
	if (!command) {
		process.stderr.write(`watchdog: no desktop notifier on ${process.platform}; the notification is only in ${NOTIFICATIONS}\n`);
		return;
	}
	const [file, args] = command;
	const result = spawnSync(file, args, { stdio: "ignore", timeout: DESKTOP_TIMEOUT_MS });
	if (result.error || result.status !== 0) {
		const why = result.error ? result.error.message : `exit ${result.status ?? result.signal}`;
		process.stderr.write(`watchdog: ${file} failed (${why}); the notification is only in ${NOTIFICATIONS}\n`);
	}
}

/** Append one line to notifications.log, then show it on the desktop unless the mode is log-only. */
function notify(dir: string, run: string, title: string, message: string, now: Date, mode: Mode): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	appendFileSync(join(dir, NOTIFICATIONS), `${iso(now)}\t${run}\t${oneLine(message)}\n`, { mode: 0o600 });
	if (mode === "desktop") desktop(title, message);
}

function label(reg: Registration): string {
	const name = reg.title ? `${reg.title} (${reg.run})` : reg.run;
	return reg.thread ? `${name}, T3 thread ${reg.thread}` : name;
}

/**
 * Quiet time runs from the later of the newest row and the registration: a fresh registration proves the run alive
 * at that moment, as when a held run is resumed long after its last row.
 */
function assess(reg: Registration, now: Date): Assessment {
	const newest = newestRow(reg.log);
	if (newest.kind === "missing") {
		return { status: "missing", key: "missing", message: `Watchdog: ${label(reg)}: its decision log is missing or unreadable at ${reg.log}. The run may have stopped.` };
	}
	const registeredAt = new Date(reg.registeredAt);
	const fromRow = newest.kind === "row" && newest.at >= registeredAt;
	const since = fromRow ? newest.at : registeredAt;
	const quietMs = now.getTime() - since.getTime();
	const thresholdMs = (2 * reg.intervalMinutes + GRACE_MINUTES) * 60_000;
	return {
		status: quietMs > thresholdMs ? "stale" : "fresh",
		since,
		key: fromRow ? iso(since) : `registered ${reg.registeredAt}`,
		message: `Watchdog: ${label(reg)}: no decision-log row for ${Math.floor(quietMs / 60_000)} minutes (${fromRow ? "last" : "registered"} ${iso(since)}). The run may have stopped.`,
	};
}

function alreadyNotified(state: ScanState | undefined, reg: Registration, a: Assessment): boolean {
	return state !== undefined && state.registeredAt === reg.registeredAt && state.notifiedFor === a.key;
}

function scanOne(dir: string, reg: Registration, now: Date, mode: Mode): ScanLine {
	const a = assess(reg, now);
	const state = readState(dir, reg.run);
	if (a.status === "fresh") {
		if (state) rmSync(statePath(dir, reg.run), { force: true });
		return { run: reg.run, status: a.status, notified: false };
	}
	if (alreadyNotified(state, reg, a)) return { run: reg.run, status: a.status, notified: false };
	notify(dir, reg.run, reg.title ?? reg.run, a.message, now, mode);
	mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 });
	writeAtomic(statePath(dir, reg.run), `${JSON.stringify({ registeredAt: reg.registeredAt, notifiedFor: a.key } satisfies ScanState)}\n`);
	return { run: reg.run, status: a.status, notified: true };
}

/** The run IDs with a registration file, sorted. */
function registeredRuns(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter(name => name.endsWith(".json"))
		.map(name => name.slice(0, -".json".length))
		.filter(run => RUN_ID.test(run))
		.sort();
}

/** Check every registered run once, then record the scan's clock. Errors in one run never stop the others. */
function scan(dir: string, now: Date, mode: Mode): ScanLine[] {
	return withLock(dir, () => {
		const lines: ScanLine[] = [];
		const runs = new Set<string>();
		for (const run of registeredRuns(dir)) {
			const reg = readRegistration(dir, run);
			if (reg === undefined) continue;
			runs.add(run);
			if (reg === "invalid") {
				process.stderr.write(`watchdog: skipping ${run}.json: not a valid registration\n`);
				lines.push({ run, status: "invalid", notified: false });
				continue;
			}
			try {
				lines.push(scanOne(dir, reg, now, mode));
			} catch (error) {
				process.stderr.write(`watchdog: ${run}: ${(error as Error).message}\n`);
			}
		}
		// State whose registration is gone belongs to an unregistered run.
		let stateNames: string[] = [];
		try {
			stateNames = readdirSync(join(dir, "state"));
		} catch {
			// No state directory yet.
		}
		for (const name of stateNames) {
			if (name.endsWith(".json") && !runs.has(name.slice(0, -".json".length))) rmSync(join(dir, "state", name), { force: true });
		}
		writeAtomic(join(dir, LAST_SCAN), `${iso(now)}\n`);
		return lines;
	});
}

/** The last scan's line: `never` when no scan has recorded one, `stale` when it is older than `maxAgeMinutes`. */
function lastScanLine(dir: string, now: Date, maxAgeMinutes: number): string {
	let value: string;
	try {
		value = readFileSync(join(dir, LAST_SCAN), "utf8").trim();
	} catch {
		return "last-scan\tnever\t-"; // No scan has run against this registry.
	}
	const at = new Date(value);
	if (!LOG_TS.test(value) || Number.isNaN(at.getTime())) return "last-scan\tnever\t-";
	const stale = now.getTime() - at.getTime() > maxAgeMinutes * 60_000;
	return `last-scan\t${stale ? "stale" : "fresh"}\t${value}`;
}

/** Read-only: the last scan's clock and each run's state, without notifying or taking the lock. */
function status(dir: string, now: Date, maxScanAgeMinutes: number, only: string | undefined): { lines: string[]; found: boolean } {
	const lines = [lastScanLine(dir, now, maxScanAgeMinutes)];
	const runs = only === undefined ? registeredRuns(dir) : [only];
	let found = true;
	for (const run of runs) {
		const reg = readRegistration(dir, run);
		if (reg === undefined) {
			lines.push(`${run}\tunregistered\t-\t-\t-`);
			found = false;
		} else if (reg === "invalid") {
			lines.push(`${run}\tinvalid\t-\t-\t-`);
		} else {
			const a = assess(reg, now);
			const notified = a.status !== "fresh" && alreadyNotified(readState(dir, run), reg, a);
			lines.push(`${run}\tregistered\t${a.status}\t${a.since ? iso(a.since) : "-"}\t${notified ? "notified" : "-"}`);
		}
	}
	return { lines, found };
}

type Flags = Map<string, string>;

/** Parse `--name value` pairs, and the bare `--name` switches in `switches`, which map to "". */
function parseFlags(args: string[], allowed: readonly string[], switches: readonly string[] = []): Flags {
	const flags: Flags = new Map();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i]!;
		if (!flag.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(flag)}`);
		const name = flag.slice(2);
		if (!allowed.includes(name) && !switches.includes(name)) throw new UsageError(`unknown option ${flag}`);
		if (flags.has(name)) throw new UsageError(`${flag} given twice`);
		if (switches.includes(name)) {
			flags.set(name, "");
			continue;
		}
		const value = args[++i];
		if (value === undefined) throw new UsageError(`${flag} needs a value`);
		flags.set(name, value);
	}
	return flags;
}

function required(flags: Flags, name: string): string {
	const value = flags.get(name);
	if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
	return value;
}

function runId(flags: Flags): string {
	const run = required(flags, "run");
	if (!RUN_ID.test(run)) throw new UsageError(`--run must match ${RUN_ID.source}`);
	return run;
}

function clock(flags: Flags): Date {
	const value = flags.get("now");
	if (value === undefined) return new Date();
	const now = new Date(value);
	if (Number.isNaN(now.getTime())) throw new UsageError(`--now must be an ISO timestamp, not ${JSON.stringify(value)}`);
	return now;
}

function minutes(flags: Flags, name: string, fallback: number): number {
	const value = flags.get(name);
	if (value === undefined) return fallback;
	const n = Number(value);
	if (value.trim() === "" || !Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_MINUTES) throw new UsageError(`--${name} must be a whole number from 1 to ${MAX_INTERVAL_MINUTES}`);
	return n;
}

function text(flags: Flags, name: string): string | undefined {
	const value = flags.get(name);
	if (value === undefined) return undefined;
	const clean = value.trim();
	if (clean === "" || clean.length > TEXT_MAX || /[\u0000-\u001f\u007f]/.test(clean)) throw new UsageError(`--${name} must be one line of 1 to ${TEXT_MAX} characters`);
	return clean;
}

function register(dir: string, flags: Flags): string {
	const run = runId(flags);
	const log = required(flags, "log");
	if (!isAbsolute(log)) throw new UsageError("--log must be an absolute path");
	const interval = Number(required(flags, "interval-minutes"));
	if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL_MINUTES) throw new UsageError(`--interval-minutes must be a whole number from 1 to ${MAX_INTERVAL_MINUTES}`);
	const title = text(flags, "title");
	const thread = text(flags, "thread");
	const replace = flags.has("replace");
	const now = clock(flags);
	try {
		if (!statSync(log).isFile()) throw new Failure(`decision log is not a regular file: ${log}`);
	} catch (error) {
		if (error instanceof Failure) throw error;
		throw new Failure(`decision log not found: ${log}`);
	}
	return withLock(dir, () => {
		const existing = readRegistration(dir, run);
		if (!replace && existing === "invalid") throw new Failure(`${registrationPath(dir, run)} is not a valid registration; pass --replace to overwrite it`);
		if (!replace && existing !== undefined && existing !== "invalid" && existing.log !== log) {
			throw new Failure(`${run} is already registered for another decision log: ${existing.log}. Pick a run ID unique to this run (its task slug and date), or pass --replace only if that registration is this run's own.`);
		}
		const reg: Registration = { version: REGISTRY_VERSION, run, log, intervalMinutes: interval, ...(title ? { title } : {}), ...(thread ? { thread } : {}), registeredAt: iso(now) };
		writeAtomic(registrationPath(dir, run), `${JSON.stringify(reg, null, "\t")}\n`);
		return `registered ${run}: ${registrationPath(dir, run)}`;
	});
}

function unregister(dir: string, flags: Flags): string {
	const run = runId(flags);
	return withLock(dir, () => {
		const existed = readRegistration(dir, run) !== undefined;
		rmSync(registrationPath(dir, run), { force: true });
		rmSync(statePath(dir, run), { force: true });
		return existed ? `unregistered ${run}` : `not registered ${run}`;
	});
}

function main(argv: string[], env: Env): number {
	const [command, ...rest] = argv;
	try {
		const dir = registryDir(env);
		switch (command) {
			case "register": {
				const flags = parseFlags(rest, ["run", "log", "interval-minutes", "title", "thread", "now"], ["replace"]);
				console.log(register(dir, flags));
				return 0;
			}
			case "unregister": {
				console.log(unregister(dir, parseFlags(rest, ["run"])));
				return 0;
			}
			case "notify": {
				const flags = parseFlags(rest, ["run", "message", "now"]);
				const run = runId(flags);
				const message = text(flags, "message");
				if (message === undefined) throw new UsageError("--message is required");
				const reg = readRegistration(dir, run);
				const title = reg !== undefined && reg !== "invalid" && reg.title ? reg.title : run;
				notify(dir, run, title, message, clock(flags), notifyMode(env));
				console.log(`notified ${run}`);
				return 0;
			}
			case "scan": {
				const flags = parseFlags(rest, ["now"]);
				const now = clock(flags);
				const mode = notifyMode(env);
				try {
					for (const line of scan(dir, now, mode)) console.log(`${line.run}\t${line.status}\t${line.notified ? "notified" : "-"}`);
				} catch (error) {
					process.stderr.write(`watchdog: scan: ${(error as Error).message}\n`);
				}
				return 0;
			}
			case "status": {
				const flags = parseFlags(rest, ["run", "now", "max-scan-age-minutes"]);
				const only = flags.has("run") ? runId(flags) : undefined;
				const result = status(dir, clock(flags), minutes(flags, "max-scan-age-minutes", MAX_SCAN_AGE_MINUTES), only);
				for (const line of result.lines) console.log(line);
				return result.found ? 0 : 1;
			}
			case "-h":
			case "--help":
			case "help":
				process.stdout.write(USAGE);
				return 0;
			default:
				throw new UsageError(command === undefined ? "a command is required" : `unknown command ${JSON.stringify(command)}`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`watchdog: ${error.message}\n\n${USAGE}`);
			return 2;
		}
		process.stderr.write(`watchdog: ${(error as Error).message}\n`);
		return 1;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2), process.env));
