import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pace, PACE_EXIT, parseSnapshot, readSnapshot, recordSnapshot, SNAPSHOT_MAX_BYTES, type Snapshot, snapshotFile, snapshotOf, STALE_AFTER_SECONDS, WINDOW_SECONDS } from "./quota.ts";

// Pace is pure over (snapshot, now), so the boundaries are tested at exact elapsed shares; the file
// half runs against a temporary XDG_STATE_HOME, and the CLI against snapshots written for the real clock.

const CLI = join(import.meta.dir, "cli.ts");
const NOW = 1_790_000_000;
const HALF_WEEK = WINDOW_SECONDS / 2;
/** A snapshot observed at NOW whose week is exactly half elapsed. */
const halfway = (usedPercent: number): Snapshot => ({ usedPercent, resetsAt: NOW + HALF_WEEK, observedAt: NOW });

const temporaryDirectories: string[] = [];
function stateHome(): string {
	const directory = mkdtempSync(join(tmpdir(), "quota-test-"));
	temporaryDirectories.push(directory);
	return directory;
}
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pace", () => {
	test("compares usage with the elapsed share at its boundaries", () => {
		expect(pace(halfway(0), NOW).state).toBe("under");
		expect(pace(halfway(50), NOW).state).toBe("under");
		expect(pace(halfway(50.01), NOW).state).toBe("over");
		expect(pace(halfway(64.99), NOW).state).toBe("over");
		expect(pace(halfway(65), NOW).state).toBe("exhausted");
		const result = pace(halfway(42), NOW);
		expect(result).toEqual({ state: "under", reason: "usage is at or behind the elapsed share of the week", usedPercent: 42, elapsedPercent: 50, resetsAt: NOW + HALF_WEEK });
	});

	test("90% used is exhausted whatever the pace", () => {
		const nearlyOver = { resetsAt: NOW + 60, observedAt: NOW };
		expect(pace({ usedPercent: 89.99, ...nearlyOver }, NOW).state).toBe("under");
		expect(pace({ usedPercent: 90, ...nearlyOver }, NOW).state).toBe("exhausted");
		expect(pace({ usedPercent: 100, ...nearlyOver }, NOW).state).toBe("exhausted");
	});

	test("the start of a week counts from resetsAt minus seven days", () => {
		const fresh = { usedPercent: 0, resetsAt: NOW + WINDOW_SECONDS, observedAt: NOW };
		expect(pace(fresh, NOW)).toMatchObject({ state: "under", elapsedPercent: 0 });
		expect(pace({ ...fresh, usedPercent: 0.01 }, NOW).state).toBe("over");
		expect(pace({ ...fresh, usedPercent: 15 }, NOW).state).toBe("exhausted");
	});

	test("unknown without a snapshot, after a reset, or when stale", () => {
		expect(pace(undefined, NOW).state).toBe("unknown");
		const observed = { usedPercent: 10, resetsAt: NOW + HALF_WEEK, observedAt: NOW - STALE_AFTER_SECONDS };
		expect(pace(observed, NOW).state).toBe("under");
		expect(pace({ ...observed, observedAt: observed.observedAt - 1 }, NOW).state).toBe("unknown");
		const reset = { usedPercent: 10, resetsAt: NOW, observedAt: NOW - 60 };
		expect(pace(reset, NOW)).toEqual({ state: "unknown", reason: "the recorded week has reset since it was observed" });
		expect(pace(reset, NOW + 1).state).toBe("unknown");
	});

	test("refuses a bad clock and a snapshot that is not one week", () => {
		for (const now of [0, -1, 1.5, NaN]) expect(() => pace(halfway(1), now)).toThrow("now must be whole positive seconds");
		expect(() => pace({ usedPercent: 1, resetsAt: NOW, observedAt: NOW }, NOW)).toThrow("one seven-day window");
		expect(() => pace({ usedPercent: 1, resetsAt: NOW + WINDOW_SECONDS + 1, observedAt: NOW }, NOW)).toThrow("one seven-day window");
	});
});

describe("snapshotOf", () => {
	const input = (window: unknown) => ({ rate_limits: { five_hour: { used_percentage: 99 }, seven_day: window } });

	test("takes the seven-day window, never the five-hour one", () => {
		expect(snapshotOf(input({ used_percentage: 12.5, resets_at: NOW + 3600 }), NOW)).toEqual({ usedPercent: 12.5, resetsAt: NOW + 3600, observedAt: NOW });
		expect(snapshotOf(input({ used_percentage: 12.5, resets_at: NOW + 3600.9 }), NOW)?.resetsAt).toBe(NOW + 3600);
		expect(snapshotOf(input({ used_percentage: 0, resets_at: NOW + WINDOW_SECONDS }), NOW)?.usedPercent).toBe(0);
	});

	test("is undefined when the window is missing, malformed, reset, or longer than a week", () => {
		for (const value of [null, undefined, [], "x", { rate_limits: null }, { rate_limits: { five_hour: { used_percentage: 3, resets_at: NOW + 60 } } }]) {
			expect(snapshotOf(value, NOW)).toBeUndefined();
		}
		for (const used of [undefined, null, "3", -0.01, 100.01, NaN, Infinity]) expect(snapshotOf(input({ used_percentage: used, resets_at: NOW + 60 }), NOW)).toBeUndefined();
		for (const resets of [undefined, null, "later", NaN, Infinity, NOW, NOW - 1, NOW + WINDOW_SECONDS + 1]) {
			expect(snapshotOf(input({ used_percentage: 3, resets_at: resets }), NOW)).toBeUndefined();
		}
	});
});

describe("parseSnapshot", () => {
	test("round-trips what recordSnapshot writes", () => {
		expect(parseSnapshot(`${JSON.stringify(halfway(7))}\n`)).toEqual(halfway(7));
	});

	test("rejects malformed, oversized, and inconsistent text", () => {
		const valid = JSON.stringify(halfway(7));
		for (const text of ["", "not json", "null", "[]", "7", "{}", JSON.stringify({ ...halfway(7), usedPercent: "7" }), JSON.stringify({ ...halfway(7), resetsAt: 1.5 }), JSON.stringify({ ...halfway(7), observedAt: 0 })]) {
			expect(parseSnapshot(text)).toBeUndefined();
		}
		expect(parseSnapshot(valid.padEnd(SNAPSHOT_MAX_BYTES, " "))).toEqual(halfway(7));
		expect(parseSnapshot(valid.padEnd(SNAPSHOT_MAX_BYTES + 1, " "))).toBeUndefined();
		expect(parseSnapshot(JSON.stringify({ usedPercent: 7, resetsAt: NOW, observedAt: NOW }))).toBeUndefined();
		expect(parseSnapshot(JSON.stringify({ usedPercent: 7, resetsAt: NOW + WINDOW_SECONDS + 1, observedAt: NOW }))).toBeUndefined();
	});
});

describe("snapshot file", () => {
	test("lives under XDG_STATE_HOME, else ~/.local/state", () => {
		expect(snapshotFile({ XDG_STATE_HOME: "/state" })).toBe("/state/agentic/quota/claude-seven-day.json");
		expect(snapshotFile({})).toEndWith("/.local/state/agentic/quota/claude-seven-day.json");
		expect(snapshotFile({ XDG_STATE_HOME: "" })).toEndWith("/.local/state/agentic/quota/claude-seven-day.json");
	});

	test("is written whole, private, and replaced in place", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const file = snapshotFile(env);
		recordSnapshot(halfway(7), env);
		recordSnapshot(halfway(8), env);
		expect(readSnapshot(env)).toEqual(halfway(8));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
		expect(readdirSync(dirname(file))).toEqual(["claude-seven-day.json"]);
	});

	test("a failed rename removes its temporary file and leaves no snapshot", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const file = snapshotFile(env);
		mkdirSync(join(file, "occupied"), { recursive: true });
		expect(() => recordSnapshot(halfway(7), env)).toThrow();
		expect(readdirSync(dirname(file))).toEqual(["claude-seven-day.json"]);
		expect(readSnapshot(env)).toBeUndefined();
	});

	test("a temporary file already at its path is refused and left alone", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const file = snapshotFile(env);
		mkdirSync(dirname(file), { recursive: true });
		const planted = `${file}.${process.pid}.tmp`;
		writeFileSync(planted, "planted");
		expect(() => recordSnapshot(halfway(7), env)).toThrow();
		expect(readFileSync(planted, "utf8")).toBe("planted");
		expect(readSnapshot(env)).toBeUndefined();
	});

	test("reads nothing from a missing, oversized, or irregular file", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const file = snapshotFile(env);
		expect(readSnapshot(env)).toBeUndefined();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(halfway(7)).padEnd(SNAPSHOT_MAX_BYTES + 1, " "));
		expect(readSnapshot(env)).toBeUndefined();
		rmSync(file);
		mkdirSync(file);
		expect(readSnapshot(env)).toBeUndefined();
		rmSync(file, { recursive: true });
		expect(spawnSync("mkfifo", [file]).status).toBe(0);
		// A FIFO with no writer would block a plain read forever; the size check must answer first.
		expect(readSnapshot(env)).toBeUndefined();
	});
});

describe("cli", () => {
	const run = (args: string[], env: Record<string, string>) => spawnSync("bun", [CLI, ...args], { env: { ...process.env, ...env }, timeout: 10_000 });
	const recordAt = (env: { XDG_STATE_HOME: string }, usedPercent: number, elapsedSeconds: number) => {
		const now = Math.floor(Date.now() / 1000);
		recordSnapshot({ usedPercent, resetsAt: now - elapsedSeconds + WINDOW_SECONDS, observedAt: now }, env);
	};

	test("prints the state and exits with its code", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const unknown = run(["pace"], env);
		expect(unknown.status).toBe(PACE_EXIT.unknown);
		expect(unknown.stdout.toString()).toStartWith("unknown (no recorded Claude rate limits");
		for (const [used, state] of [[10, "under"], [60, "over"], [70, "exhausted"]] as const) {
			recordAt(env, used, HALF_WEEK);
			const result = run(["pace"], env);
			expect(result.status).toBe(PACE_EXIT[state]);
			expect(result.stdout.toString()).toStartWith(`${state}: ${used}% used, 50% of the week elapsed (`);
		}
	});

	test("--json prints the result", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordAt(env, 60, HALF_WEEK);
		const result = run(["pace", "--json"], env);
		expect(result.status).toBe(PACE_EXIT.over);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ state: "over", usedPercent: 60 });
	});

	test("usage errors exit 2 and help exits 0", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		for (const args of [[], ["status"], ["pace", "extra"], ["pace", "--jsn"]]) {
			const result = run(args, env);
			expect(result.status).toBe(2);
			expect(result.stderr.toString()).toStartWith("Usage: quota pace [--json]");
		}
		const help = run(["--help"], env);
		expect(help.status).toBe(0);
		expect(help.stdout.toString()).toContain("exhausted   exit 4");
	});
});
