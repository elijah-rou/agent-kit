// The Claude weekly quota's pace: how much of the seven-day window is used against how much of it has
// elapsed. The statusline is the only place Claude hands over its rate limits, so it records them here
// and `agentic quota pace` reads them back.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const WINDOW_SECONDS = 7 * 24 * 3600;
export const SNAPSHOT_MAX_BYTES = 4096;
/** Entries the snapshot directory may hold; writers keep it to one, or a few while sessions race. */
export const SNAPSHOT_ENTRIES_MAX = 64;
/** Older than this, a snapshot no longer describes the week: no session has rendered a statusline lately. */
export const STALE_AFTER_SECONDS = 2 * 3600;
/** Points of usage above the elapsed share at which the week is on course to run out well before reset. */
export const EXHAUSTED_MARGIN_POINTS = 15;
/** Usage at which the week counts as run out whatever the pace, so the last points stay for risky work. */
export const EXHAUSTED_AT_PERCENT = 90;

export type PaceState = "under" | "over" | "exhausted" | "unknown";
export const PACE_EXIT: Record<PaceState, number> = { under: 0, over: 3, exhausted: 4, unknown: 5 };

export interface Snapshot { usedPercent: number; resetsAt: number; observedAt: number }
export type Pace =
	| { state: "unknown"; reason: string }
	| { state: Exclude<PaceState, "unknown">; reason: string; usedPercent: number; elapsedPercent: number; resetsAt: number };

type Environment = Record<string, string | undefined>;

const fields = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const wholeSeconds = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2 ** 53 - 1;
const percent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export function snapshotDirectory(env: Environment): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentic", "quota", "claude-seven-day");
}

/** The seven-day window from the statusline's stdin, or undefined when Claude supplied none or it is malformed. */
export function snapshotOf(statuslineInput: unknown, now: number): Snapshot | undefined {
	if (!wholeSeconds(now)) throw new Error("now must be whole positive seconds");
	const window = fields(fields(fields(statuslineInput)?.rate_limits)?.seven_day);
	const usedPercent = window?.used_percentage;
	const resetsAtRaw = window?.resets_at;
	if (!percent(usedPercent)) return undefined;
	if (typeof resetsAtRaw !== "number" || !Number.isFinite(resetsAtRaw)) return undefined;
	// Claude sends whole epoch seconds; a fractional value is floored as the statusline's countdown does.
	const resetsAt = Math.floor(resetsAtRaw);
	if (resetsAt <= now) return undefined;
	if (resetsAt > now + WINDOW_SECONDS) return undefined;
	return { usedPercent, resetsAt, observedAt: now };
}

/**
 * Record the snapshot unless a greater one is recorded. Every open Claude Code session keeps rendering from
 * its own last response, so an idle session supplies an old, lower usage: within a week usage only rises,
 * and a lower view is dropped without touching the record or its observedAt.
 *
 * Each entry is named for its (resetsAt, usedPercent) key and the greatest entry is the record, so no write
 * replaces a different value: racing writers with different usage leave both entries, and racing writers
 * with the same usage replace one entry whole, differing only in observedAt. A writer removes only entries
 * below the one it wrote, so the greatest entry ever written stays until a later week replaces it.
 */
export function recordSnapshot(snapshot: Snapshot, env: Environment): void {
	if (!consistent(snapshot)) throw new Error("snapshot must describe one seven-day window");
	const directory = snapshotDirectory(env);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const entries = listEntries(directory);
	const recorded = entries[0];
	if (recorded !== undefined && compareKeys(snapshot, recorded) < 0) return;
	writeWhole(join(directory, entryName(snapshot)), `${JSON.stringify(snapshot)}\n`);
	for (const lower of entries.filter(entry => compareKeys(entry, snapshot) < 0)) {
		rmSync(join(directory, entryName(lower)), { force: true });
	}
}

/** Write `text` to `file` whole: a reader never sees a half-written file. */
function writeWhole(file: string, text: string): void {
	// The process ID keeps concurrent sessions off each other's temporary file; "wx" refuses one left behind or
	// planted, and that file is not this call's to remove.
	const temporary = join(dirname(file), `.${process.pid}.tmp`);
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeFileSync(descriptor, text);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** The snapshot in `text`, or undefined when it is oversized, malformed, or not one seven-day window. */
export function parseSnapshot(text: string): Snapshot | undefined {
	if (Buffer.byteLength(text) > SNAPSHOT_MAX_BYTES) return undefined;
	let value: unknown;
	try { value = JSON.parse(text); } catch { return undefined; }
	const snapshot = fields(value);
	if (snapshot === undefined) return undefined;
	const { usedPercent, resetsAt, observedAt } = snapshot;
	if (!percent(usedPercent)) return undefined;
	if (!wholeSeconds(resetsAt)) return undefined;
	if (!wholeSeconds(observedAt)) return undefined;
	const parsed = { usedPercent, resetsAt, observedAt };
	return consistent(parsed) ? parsed : undefined;
}

/**
 * The recorded snapshot: the greatest entry, or undefined when there is none, the entry is anything but a
 * small regular file, or its contents disagree with its name.
 */
export function readSnapshot(env: Environment): Snapshot | undefined {
	const directory = snapshotDirectory(env);
	let recorded: Key | undefined;
	let text: string;
	try {
		recorded = listEntries(directory)[0];
		if (recorded === undefined) return undefined;
		const file = join(directory, entryName(recorded));
		// Checked before reading so a directory, a FIFO, or a huge file at the path cannot block or bloat the read.
		const stat = statSync(file);
		if (!stat.isFile()) return undefined;
		if (stat.size > SNAPSHOT_MAX_BYTES) return undefined;
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const snapshot = parseSnapshot(text);
	if (snapshot === undefined) return undefined;
	return compareKeys(snapshot, recorded) === 0 ? snapshot : undefined;
}

/**
 * Pure: the pace of a snapshot at `now`. Unknown without a snapshot, after its week resets, or once it is
 * stale; a snapshot that is not one seven-day window is a programmer error and throws.
 */
export function pace(snapshot: Snapshot | undefined, now: number): Pace {
	if (!wholeSeconds(now)) throw new Error("now must be whole positive seconds");
	if (snapshot === undefined) return { state: "unknown", reason: "no recorded Claude rate limits; a Claude Code session with the statusline records them" };
	if (!consistent(snapshot)) throw new Error("snapshot must describe one seven-day window");
	if (snapshot.resetsAt <= now) return { state: "unknown", reason: "the recorded week has reset since it was observed" };
	if (now - snapshot.observedAt > STALE_AFTER_SECONDS) return { state: "unknown", reason: `the recorded rate limits are older than ${STALE_AFTER_SECONDS / 3600} hours` };
	const windowStart = snapshot.resetsAt - WINDOW_SECONDS;
	// The clamp covers a clock set back since the observation; resetsAt > now already bounds it above.
	const elapsedSeconds = Math.max(now - windowStart, 0);
	if (!(elapsedSeconds < WINDOW_SECONDS)) throw new Error("elapsed time must stay inside the window");
	const elapsedPercent = (100 * elapsedSeconds) / WINDOW_SECONDS;
	const measured = { usedPercent: snapshot.usedPercent, elapsedPercent, resetsAt: snapshot.resetsAt };
	if (snapshot.usedPercent >= EXHAUSTED_AT_PERCENT) return { state: "exhausted", reason: `at least ${EXHAUSTED_AT_PERCENT}% of the week is used`, ...measured };
	if (snapshot.usedPercent >= elapsedPercent + EXHAUSTED_MARGIN_POINTS) {
		return { state: "exhausted", reason: `usage is ${EXHAUSTED_MARGIN_POINTS} or more points ahead of the elapsed share`, ...measured };
	}
	if (snapshot.usedPercent > elapsedPercent) return { state: "over", reason: "usage is ahead of the elapsed share of the week", ...measured };
	return { state: "under", reason: "usage is at or behind the elapsed share of the week", ...measured };
}

/** An observation happens inside the window it reports: before the reset and no more than a week ahead of it. */
function consistent(snapshot: Snapshot): boolean {
	if (snapshot.observedAt >= snapshot.resetsAt) return false;
	return snapshot.resetsAt - snapshot.observedAt <= WINDOW_SECONDS;
}

type Key = Pick<Snapshot, "resetsAt" | "usedPercent">;

/** Orders by week (resetsAt), then by usage within the week. */
const compareKeys = (a: Key, b: Key): number => a.resetsAt - b.resetsAt || a.usedPercent - b.usedPercent;
const entryName = (key: Key): string => `${key.resetsAt}_${key.usedPercent}.json`;

/** The key an entry's name holds, or undefined for any other name, temporary files included. */
function keyOf(name: string): Key | undefined {
	const match = /^(\d+)_([^_/]+)\.json$/.exec(name);
	if (match === null) return undefined;
	const key = { resetsAt: Number(match[1]), usedPercent: Number(match[2]) };
	if (!wholeSeconds(key.resetsAt)) return undefined;
	if (!percent(key.usedPercent)) return undefined;
	// Only the name entryName would write counts, so one key has one entry.
	return entryName(key) === name ? key : undefined;
}

/** The keys of the snapshot entries in `directory`, greatest first. */
function listEntries(directory: string): Key[] {
	const names = readdirSync(directory);
	if (names.length > SNAPSHOT_ENTRIES_MAX) throw new Error(`more than ${SNAPSHOT_ENTRIES_MAX} entries in ${directory}`);
	const keys = names.flatMap(name => {
		const key = keyOf(name);
		return key === undefined ? [] : [key];
	});
	return keys.sort((a, b) => compareKeys(b, a));
}
