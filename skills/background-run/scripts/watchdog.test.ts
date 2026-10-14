import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopCommand, GRACE_MINUTES, MAX_SCAN_AGE_MINUTES, registryDir } from "./watchdog.ts";

const SCRIPT = join(import.meta.dir, "watchdog.ts");
const LOG_SH = join(import.meta.dir, "..", "..", "show-me-your-work", "scripts", "log.sh");
const SECRET = "do-not-leak-7f3a";
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
	dir: string;
	registry: string;
	log: string;
}
function fixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "watchdog-"));
	made.push(dir);
	const log = join(dir, "run.tsv");
	writeFileSync(log, "ts\tphase\tdecision\twhy\tevidence\tresult\n");
	return { dir, registry: join(dir, "registry"), log };
}
function row(f: Fixture, ts: string): void {
	appendFileSync(f.log, `${ts}\ttick\t${SECRET}\twhy ${SECRET}\tevidence\tno progress\n`);
}
function run(f: Fixture, args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: { PATH: process.env.PATH, HOME: f.dir, AGENTIC_WATCHDOG_DIR: f.registry, AGENTIC_WATCHDOG_NOTIFY: "log", ...env },
		timeout: 20_000,
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
function notifications(f: Fixture): string[] {
	const path = join(f.registry, "notifications.log");
	return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n") : [];
}
function register(f: Fixture, now = "2026-10-14T10:00:00Z", extra: string[] = []) {
	const result = run(f, ["register", "--run", "prog-1", "--log", f.log, "--interval-minutes", "60", "--now", now, ...extra]);
	expect(result).toMatchObject({ code: 0, stderr: "" });
	return result;
}
const scanAt = (f: Fixture, now: string) => run(f, ["scan", "--now", now]);

// Interval 60 and the grace period: a row at 10:00 is stale only after 12:15.
const LIMIT_MINUTES = 2 * 60 + GRACE_MINUTES;

describe("scan", () => {
	test("a log quiet for exactly the limit is fresh, one second more notifies once, and repeats stay silent", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		expect(LIMIT_MINUTES).toBe(135);

		expect(scanAt(f, "2026-10-14T12:15:00Z")).toEqual({ code: 0, stdout: "prog-1\tfresh\t-\n", stderr: "" });
		expect(notifications(f)).toEqual([]);

		expect(scanAt(f, "2026-10-14T12:15:01Z")).toEqual({ code: 0, stdout: "prog-1\tstale\tnotified\n", stderr: "" });
		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\t-\n");
		expect(scanAt(f, "2026-10-14T20:00:00Z").stdout).toBe("prog-1\tstale\t-\n");
		const lines = notifications(f);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith("2026-10-14T12:15:01Z\tprog-1\tWatchdog: prog-1: no decision-log row for 135 minutes (last 2026-10-14T10:00:00Z).");
	});

	test("when the log moves the notified state clears, and a later stall notifies again", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
		expect(existsSync(join(f.registry, "state", "prog-1.json"))).toBe(true);

		row(f, "2026-10-14T13:05:00Z");
		expect(scanAt(f, "2026-10-14T13:10:00Z").stdout).toBe("prog-1\tfresh\t-\n");
		expect(existsSync(join(f.registry, "state", "prog-1.json"))).toBe(false);

		expect(scanAt(f, "2026-10-14T16:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
		expect(scanAt(f, "2026-10-14T17:00:00Z").stdout).toBe("prog-1\tstale\t-\n");
		expect(notifications(f)).toHaveLength(2);
		expect(notifications(f)[1]).toContain("(last 2026-10-14T13:05:00Z)");
	});

	test("a missing log notifies once, and its return clears the state", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f, "2026-10-14T10:00:00Z", ["--title", "Overnight queue", "--thread", "thread-abc"]);
		rmSync(f.log);
		expect(scanAt(f, "2026-10-14T10:05:00Z").stdout).toBe("prog-1\tmissing\tnotified\n");
		expect(scanAt(f, "2026-10-14T10:10:00Z").stdout).toBe("prog-1\tmissing\t-\n");
		expect(notifications(f)).toEqual([`2026-10-14T10:05:00Z\tprog-1\tWatchdog: Overnight queue (prog-1), T3 thread thread-abc: its decision log is missing or unreadable at ${f.log}. The run may have stopped.`]);

		writeFileSync(f.log, "ts\tphase\tdecision\twhy\tevidence\tresult\n");
		row(f, "2026-10-14T10:20:00Z");
		expect(scanAt(f, "2026-10-14T10:25:00Z").stdout).toBe("prog-1\tfresh\t-\n");
		expect(existsSync(join(f.registry, "state", "prog-1.json"))).toBe(false);
	});

	test("a log with only its header is measured from the registration", () => {
		const f = fixture();
		register(f, "2026-10-14T10:00:00Z");
		expect(scanAt(f, "2026-10-14T12:15:00Z").stdout).toBe("prog-1\tfresh\t-\n");
		expect(scanAt(f, "2026-10-14T12:16:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
		expect(notifications(f)[0]).toContain("(registered 2026-10-14T10:00:00Z)");
	});

	test("the newest row wins, even out of order, and a long log is read from its tail", () => {
		const f = fixture();
		const filler = "x".repeat(200);
		for (let i = 0; i < 1000; i++) appendFileSync(f.log, `2026-10-13T00:00:00Z\tfill\t${filler}\tw\te\tr\n`);
		row(f, "2026-10-14T11:00:00Z");
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		expect(scanAt(f, "2026-10-14T13:15:00Z").stdout).toBe("prog-1\tfresh\t-\n");
		expect(scanAt(f, "2026-10-14T13:15:01Z").stdout).toBe("prog-1\tstale\tnotified\n");
	});

	test("a row log.sh just wrote is fresh on the real clock", () => {
		const f = fixture();
		const appended = spawnSync("bash", [LOG_SH, f.log, "tick", "audit", "why", "evidence", "progress"], { encoding: "utf8" });
		expect(appended.status).toBe(0);
		expect(run(f, ["register", "--run", "prog-1", "--log", f.log, "--interval-minutes", "1"]).code).toBe(0);
		expect(run(f, ["scan"])).toEqual({ code: 0, stdout: "prog-1\tfresh\t-\n", stderr: "" });
	});

	test("scan never prints or records the log's contents", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		const result = scanAt(f, "2026-10-14T18:00:00Z");
		expect(result.stdout + result.stderr).not.toContain(SECRET);
		for (const name of readdirSync(f.registry, { recursive: true, encoding: "utf8" })) {
			const path = join(f.registry, name);
			if (name.endsWith(".json") || name.endsWith(".log")) expect(readFileSync(path, "utf8")).not.toContain(SECRET);
		}
	});

	test("an invalid registration is skipped and the others still run; scan exits 0", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		writeFileSync(join(f.registry, "broken.json"), "{not json");
		const result = scanAt(f, "2026-10-14T13:00:00Z");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("broken\tinvalid\t-\nprog-1\tstale\tnotified\n");
		expect(result.stderr).toBe("watchdog: skipping broken.json: not a valid registration\n");
	});

	test("an empty or absent registry scans to nothing and still records the scan", () => {
		const f = fixture();
		expect(scanAt(f, "2026-10-14T13:00:00Z")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(readFileSync(join(f.registry, "last-scan"), "utf8")).toBe("2026-10-14T13:00:00Z\n");
	});

	test("a log that is not a regular file counts as missing and never blocks the scan", () => {
		const f = fixture();
		register(f);
		const fifo = join(f.dir, "fifo.tsv");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		writeFileSync(join(f.registry, "prog-1.json"), JSON.stringify({ version: 1, run: "prog-1", log: fifo, intervalMinutes: 60, registeredAt: "2026-10-14T10:00:00Z" }));
		expect(scanAt(f, "2026-10-14T10:05:00Z")).toEqual({ code: 0, stdout: "prog-1\tmissing\tnotified\n", stderr: "" });
	});
});

describe("register and unregister", () => {
	test("register writes one JSON file per run; re-registering resets the notified state", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f, "2026-10-14T10:00:00Z", ["--title", "Queue"]);
		expect(readdirSync(f.registry)).toEqual(["prog-1.json"]);
		expect(JSON.parse(readFileSync(join(f.registry, "prog-1.json"), "utf8"))).toEqual({ version: 1, run: "prog-1", log: f.log, intervalMinutes: 60, title: "Queue", registeredAt: "2026-10-14T10:00:00Z" });
		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
	});

	test("a re-registration after a long quiet spell is measured from the registration, not the old row", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");

		// A held run resumed overnight: the re-arm proves it alive, though its newest row is old.
		register(f, "2026-10-15T08:00:00Z");
		expect(scanAt(f, "2026-10-15T08:15:00Z").stdout).toBe("prog-1\tfresh\t-\n");
		expect(scanAt(f, "2026-10-15T10:15:00Z").stdout).toBe("prog-1\tfresh\t-\n");
		expect(scanAt(f, "2026-10-15T10:15:01Z").stdout).toBe("prog-1\tstale\tnotified\n");
		expect(notifications(f)[1]).toContain("(registered 2026-10-15T08:00:00Z)");

		// A row newer than the registration is measured as before.
		row(f, "2026-10-15T11:00:00Z");
		expect(scanAt(f, "2026-10-15T13:15:00Z").stdout).toBe("prog-1\tfresh\t-\n");
	});

	test("a registration without version 1 is invalid", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		const path = join(f.registry, "prog-1.json");
		const { version: _, ...unversioned } = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify(unversioned));
		expect(scanAt(f, "2026-10-14T13:00:00Z")).toEqual({ code: 0, stdout: "prog-1\tinvalid\t-\n", stderr: "watchdog: skipping prog-1.json: not a valid registration\n" });
	});

	test("register refuses a run ID already registered for another log unless --replace, and re-arms the same log", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		const other = join(f.dir, "other.tsv");
		writeFileSync(other, "ts\tphase\tdecision\twhy\tevidence\tresult\n");
		const clash = run(f, ["register", "--run", "prog-1", "--log", other, "--interval-minutes", "60", "--now", "2026-10-14T11:00:00Z"]);
		expect(clash.code).toBe(1);
		expect(clash.stderr).toContain(`prog-1 is already registered for another decision log: ${f.log}`);
		expect(JSON.parse(readFileSync(join(f.registry, "prog-1.json"), "utf8")).log).toBe(f.log);

		register(f, "2026-10-14T11:30:00Z");
		expect(JSON.parse(readFileSync(join(f.registry, "prog-1.json"), "utf8")).registeredAt).toBe("2026-10-14T11:30:00Z");

		expect(run(f, ["register", "--run", "prog-1", "--log", other, "--interval-minutes", "60", "--replace"]).code).toBe(0);
		expect(JSON.parse(readFileSync(join(f.registry, "prog-1.json"), "utf8")).log).toBe(other);
	});

	test("register refuses to overwrite an invalid registration unless --replace", () => {
		const f = fixture();
		mkdirSync(f.registry, { recursive: true });
		writeFileSync(join(f.registry, "prog-1.json"), "{not json");
		const result = run(f, ["register", "--run", "prog-1", "--log", f.log, "--interval-minutes", "60"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not a valid registration");
		expect(run(f, ["register", "--run", "prog-1", "--log", f.log, "--interval-minutes", "60", "--replace"]).code).toBe(0);
	});

	test("unregister removes the registration and its state, is idempotent, and scan then notifies nothing", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
		expect(run(f, ["unregister", "--run", "prog-1"])).toEqual({ code: 0, stdout: "unregistered prog-1\n", stderr: "" });
		expect(run(f, ["unregister", "--run", "prog-1"])).toEqual({ code: 0, stdout: "not registered prog-1\n", stderr: "" });
		expect(scanAt(f, "2026-10-14T20:00:00Z").stdout).toBe("");
		expect(existsSync(join(f.registry, "state", "prog-1.json"))).toBe(false);
		expect(notifications(f)).toHaveLength(1);
	});

	test("scan drops state left by a run unregistered mid-scan", () => {
		const f = fixture();
		mkdirSync(join(f.registry, "state"), { recursive: true });
		writeFileSync(join(f.registry, "state", "gone.json"), JSON.stringify({ registeredAt: "2026-10-14T10:00:00Z", notifiedFor: "missing" }));
		expect(scanAt(f, "2026-10-14T13:00:00Z").code).toBe(0);
		expect(readdirSync(join(f.registry, "state"))).toEqual([]);
	});

	test("register refuses a missing log", () => {
		const f = fixture();
		const result = run(f, ["register", "--run", "prog-1", "--log", join(f.dir, "absent.tsv"), "--interval-minutes", "60"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("decision log not found");
		expect(existsSync(f.registry)).toBe(false);
	});
});

describe("status", () => {
	test("prints the last scan and each run's registration and state without notifying", () => {
		const f = fixture();
		expect(run(f, ["status"])).toEqual({ code: 0, stdout: "last-scan\tnever\t-\n", stderr: "" });

		row(f, "2026-10-14T10:00:00Z");
		register(f);
		expect(run(f, ["status", "--now", "2026-10-14T11:00:00Z"]).stdout).toBe("last-scan\tnever\t-\nprog-1\tregistered\tfresh\t2026-10-14T10:00:00Z\t-\n");
		expect(run(f, ["status", "--now", "2026-10-14T13:00:00Z"]).stdout).toBe("last-scan\tnever\t-\nprog-1\tregistered\tstale\t2026-10-14T10:00:00Z\t-\n");
		expect(notifications(f)).toEqual([]);

		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
		expect(run(f, ["status", "--run", "prog-1", "--now", "2026-10-14T13:05:00Z"])).toEqual({
			code: 0,
			stdout: "last-scan\tfresh\t2026-10-14T13:00:00Z\nprog-1\tregistered\tstale\t2026-10-14T10:00:00Z\tnotified\n",
			stderr: "",
		});
	});

	test("--run names one run, and an unregistered one reads unregistered and exits 1", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		scanAt(f, "2026-10-14T10:55:00Z");
		expect(run(f, ["status", "--run", "other", "--now", "2026-10-14T11:00:00Z"])).toEqual({
			code: 1,
			stdout: "last-scan\tfresh\t2026-10-14T10:55:00Z\nother\tunregistered\t-\t-\t-\n",
			stderr: "",
		});
	});

	test("an invalid registration reads invalid, not registered", () => {
		const f = fixture();
		mkdirSync(f.registry, { recursive: true });
		writeFileSync(join(f.registry, "prog-1.json"), "{}\n");
		expect(run(f, ["status", "--run", "prog-1", "--now", "2026-10-14T11:00:00Z"]).stdout).toBe("last-scan\tnever\t-\nprog-1\tinvalid\t-\t-\t-\n");
	});

	test("a last scan older than the limit reads stale: a timer that ran once and died is not watching", () => {
		const f = fixture();
		expect(scanAt(f, "2026-09-01T00:00:00Z").code).toBe(0); // The timer's only scan.
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		expect(run(f, ["status", "--run", "prog-1", "--now", "2026-10-14T10:05:00Z"])).toEqual({
			code: 0,
			stdout: "last-scan\tstale\t2026-09-01T00:00:00Z\nprog-1\tregistered\tfresh\t2026-10-14T10:00:00Z\t-\n",
			stderr: "",
		});
	});

	test(`a last scan exactly ${MAX_SCAN_AGE_MINUTES} minutes old is fresh, one second more is stale`, () => {
		const f = fixture();
		scanAt(f, "2026-10-14T10:00:00Z");
		const at = (now: string, extra: string[] = []) => run(f, ["status", "--now", now, ...extra]).stdout;
		expect(MAX_SCAN_AGE_MINUTES).toBe(30);
		expect(at("2026-10-14T10:30:00Z")).toBe("last-scan\tfresh\t2026-10-14T10:00:00Z\n");
		expect(at("2026-10-14T10:30:01Z")).toBe("last-scan\tstale\t2026-10-14T10:00:00Z\n");
		expect(at("2026-10-14T10:30:01Z", ["--max-scan-age-minutes", "31"])).toBe("last-scan\tfresh\t2026-10-14T10:00:00Z\n");
		expect(at("2026-10-14T10:05:01Z", ["--max-scan-age-minutes", "5"])).toBe("last-scan\tstale\t2026-10-14T10:00:00Z\n");
	});

	test("a corrupt last-scan file reads never", () => {
		const f = fixture();
		mkdirSync(f.registry, { recursive: true });
		writeFileSync(join(f.registry, "last-scan"), "garbage\n");
		expect(run(f, ["status"]).stdout).toBe("last-scan\tnever\t-\n");
	});
});

describe("registry lock", () => {
	const lockDir = (f: Fixture) => join(f.registry, ".lock");
	function holdLock(f: Fixture, pid: number): void {
		mkdirSync(lockDir(f), { recursive: true });
		writeFileSync(join(lockDir(f), "owner"), `${pid} test\n`);
	}
	function spawnCli(f: Fixture, args: string[]) {
		return Bun.spawn([process.execPath, SCRIPT, ...args], {
			env: { PATH: process.env.PATH, HOME: f.dir, AGENTIC_WATCHDOG_DIR: f.registry, AGENTIC_WATCHDOG_NOTIFY: "log" },
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	test("scan waits while another process holds the lock, then runs", async () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		holdLock(f, process.pid);
		const scan = spawnCli(f, ["scan", "--now", "2026-10-14T13:00:00Z"]);
		await Bun.sleep(1500);
		expect(notifications(f)).toEqual([]);
		rmSync(lockDir(f), { recursive: true });
		expect(await scan.exited).toBe(0);
		expect(await new Response(scan.stdout).text()).toBe("prog-1\tstale\tnotified\n");
		expect(notifications(f)).toHaveLength(1);
		expect(existsSync(lockDir(f))).toBe(false);
	});

	test("register waits while another process holds the lock", async () => {
		const f = fixture();
		mkdirSync(f.registry, { recursive: true });
		holdLock(f, process.pid);
		const reg = spawnCli(f, ["register", "--run", "prog-1", "--log", f.log, "--interval-minutes", "60"]);
		await Bun.sleep(1500);
		expect(existsSync(join(f.registry, "prog-1.json"))).toBe(false);
		rmSync(lockDir(f), { recursive: true });
		expect(await reg.exited).toBe(0);
		expect(existsSync(join(f.registry, "prog-1.json"))).toBe(true);
	});

	test("a lock whose owner has exited is broken at once", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		const exited = spawnSync("true");
		holdLock(f, exited.pid);
		const result = scanAt(f, "2026-10-14T13:00:00Z");
		expect(result.stdout).toBe("prog-1\tstale\tnotified\n");
		expect(result.stderr).toContain("removed a stale lock");
		expect(existsSync(lockDir(f))).toBe(false);
	});

	test("a lock older than the stale timeout is broken even if its owner looks alive", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f);
		holdLock(f, process.pid);
		const old = new Date(Date.now() - 60 * 60_000);
		utimesSync(lockDir(f), old, old);
		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
	});
});

describe("notify", () => {
	test("works for an unregistered run, after its unregister, and appends one line", () => {
		const f = fixture();
		register(f, "2026-10-14T10:00:00Z", ["--title", "Queue"]);
		expect(run(f, ["unregister", "--run", "prog-1"]).code).toBe(0);
		expect(run(f, ["notify", "--run", "prog-1", "--message", "Paused: three ticks without progress", "--now", "2026-10-14T11:00:00Z"])).toEqual({ code: 0, stdout: "notified prog-1\n", stderr: "" });
		expect(notifications(f)).toEqual(["2026-10-14T11:00:00Z\tprog-1\tPaused: three ticks without progress"]);
	});

	const hostile = '-e do shell script "x" \\ then\nquit';
	const hostileTitle = 'Run "q"; display dialog "x"';

	test("osascript gets the message and title as argv after --, never inside the script", () => {
		const [file, args] = desktopCommand("darwin", hostileTitle, hostile)!;
		expect(file).toBe("osascript");
		expect(args).toEqual(["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", "--", '-e do shell script "x" \\ then quit', hostileTitle]);
	});

	test("notify-send gets the title and message as argv after --, and is skipped where it is absent", () => {
		expect(desktopCommand("linux", hostileTitle, hostile, () => "/usr/bin/notify-send")).toEqual(["/usr/bin/notify-send", ["--app-name=agentic watchdog", "--", hostileTitle, '-e do shell script "x" \\ then quit']]);
		expect(desktopCommand("linux", "t", "m", () => null)).toBeUndefined();
		expect(desktopCommand("win32", "t", "m")).toBeUndefined();
	});

	// Runs the same argv with the display line swapped for one that returns the arguments, so nothing is shown.
	test.if(process.platform === "darwin")("osascript hands the argv to the script unchanged", () => {
		const [file, args] = desktopCommand("darwin", hostileTitle, hostile)!;
		const echo = args.map(arg => (arg.startsWith("display notification") ? 'return (item 1 of argv) & "|" & (item 2 of argv) & "|" & (count of argv)' : arg));
		const result = spawnSync(file, echo, { encoding: "utf8" });
		expect(result).toMatchObject({ status: 0, stdout: `-e do shell script "x" \\ then quit|${hostileTitle}|2\n` });
		const compiled = join(mkdtempSync(join(tmpdir(), "watchdog-osa-")), "notify.scpt");
		made.push(join(compiled, ".."));
		expect(spawnSync("osacompile", ["-o", compiled, ...args.slice(0, args.indexOf("--"))]).status).toBe(0);
	});
});

describe("usage", () => {
	const cases: [string, string[]][] = [
		["no command", []],
		["an unknown command", ["watch"]],
		["status with an unknown option", ["status", "--verbose", "1"]],
		["a zero scan age", ["status", "--max-scan-age-minutes", "0"]],
		["a fractional scan age", ["status", "--max-scan-age-minutes", "2.5"]],
		["an empty scan age", ["status", "--max-scan-age-minutes", ""]],
		["--replace with a value", ["register", "--run", "a", "--log", "/tmp/x.tsv", "--interval-minutes", "5", "--replace", "yes"]],
		["scan with an argument", ["scan", "extra"]],
		["scan with an unknown option", ["scan", "--verbose", "1"]],
		["a bad clock", ["scan", "--now", "yesterday"]],
		["register without --run", ["register", "--log", "/tmp/x.tsv", "--interval-minutes", "60"]],
		["a run ID with a path", ["unregister", "--run", "../escape"]],
		["a relative log", ["register", "--run", "a", "--log", "run.tsv", "--interval-minutes", "60"]],
		["a zero interval", ["register", "--run", "a", "--log", "/tmp/x.tsv", "--interval-minutes", "0"]],
		["a fractional interval", ["register", "--run", "a", "--log", "/tmp/x.tsv", "--interval-minutes", "1.5"]],
		["a multi-line title", ["register", "--run", "a", "--log", "/tmp/x.tsv", "--interval-minutes", "5", "--title", "a\nb"]],
		["a repeated option", ["unregister", "--run", "a", "--run", "b"]],
		["notify without a message", ["notify", "--run", "a"]],
		["an option with no value", ["notify", "--run"]],
	];
	for (const [name, args] of cases) {
		test(`${name} exits 2 and prints the usage`, () => {
			const f = fixture();
			const result = run(f, args);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("Usage:");
			expect(existsSync(f.registry)).toBe(false);
		});
	}

	test("an unknown notification mode is a usage error, even for scan", () => {
		const f = fixture();
		expect(run(f, ["scan"], { AGENTIC_WATCHDOG_NOTIFY: "slack" }).code).toBe(2);
	});
});

describe("registryDir", () => {
	test("prefers AGENTIC_WATCHDOG_DIR, then XDG_STATE_HOME, then HOME", () => {
		expect(registryDir({ AGENTIC_WATCHDOG_DIR: "/w", XDG_STATE_HOME: "/s", HOME: "/h" })).toBe("/w");
		expect(registryDir({ XDG_STATE_HOME: "/s", HOME: "/h" })).toBe("/s/agentic/watchdog");
		expect(registryDir({ HOME: "/h" })).toBe("/h/.local/state/agentic/watchdog");
	});
});
