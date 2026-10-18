// The Claude weekly quota's pace: how much of the seven-day window is used against how much of it has
// elapsed. The statusline is the only place Claude hands over its rate limits, so it records them here
// and `agentic quota pace` reads them back.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const WINDOW_SECONDS = 7 * 24 * 3600;
export const SNAPSHOT_MAX_BYTES = 4096;
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

export function snapshotFile(env: Environment): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentic", "quota", "claude-seven-day.json");
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

/** Write the snapshot whole: a reader never sees a half-written file, and two writers leave one complete copy. */
export function recordSnapshot(snapshot: Snapshot, env: Environment): void {
	if (!consistent(snapshot)) throw new Error("snapshot must describe one seven-day window");
	const file = snapshotFile(env);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	// The process ID keeps concurrent sessions off each other's temporary file; "wx" refuses one left behind or planted.
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: "wx" });
	try {
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

/** The recorded snapshot, or undefined when there is none or the path holds anything but a small regular file. */
export function readSnapshot(env: Environment): Snapshot | undefined {
	const file = snapshotFile(env);
	let text: string;
	try {
		// Checked before reading so a directory, a FIFO, or a huge file at the path cannot block or bloat the read.
		const stat = statSync(file);
		if (!stat.isFile()) return undefined;
		if (stat.size > SNAPSHOT_MAX_BYTES) return undefined;
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	return parseSnapshot(text);
}

/** Pure: the pace of a snapshot at `now`. Unknown whenever the snapshot cannot describe the current week. */
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
