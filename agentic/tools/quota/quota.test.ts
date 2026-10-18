import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pace, PACE_EXIT, parseSnapshot, readSnapshot, recordSnapshot, SNAPSHOT_ENTRIES_MAX, SNAPSHOT_MAX_BYTES, type Snapshot, snapshotDirectory, snapshotOf, STALE_AFTER_SECONDS, WINDOW_SECONDS } from "./quota.ts";

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

	test("unknown without a snapshot, with an unreadable store, after a reset, or when stale", () => {
		expect(pace(undefined, NOW)).toEqual({ state: "unknown", reason: "no recorded Claude rate limits; a Claude Code session with the statusline records them" });
		expect(pace({ unreadable: "wedged" }, NOW)).toEqual({ state: "unknown", reason: "the recorded rate limits are unreadable: wedged" });
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

describe("snapshot directory", () => {
	/** The temporary file this process writes through, beside the entry directory. */
	const temporaryOf = (env: { XDG_STATE_HOME: string }) => join(dirname(snapshotDirectory(env)), `.claude-seven-day.${process.pid}.tmp`);
	/** The entry recordSnapshot writes for a snapshot, named for its week and usage. */
	const entryOf = (env: { XDG_STATE_HOME: string }, snapshot: Snapshot) => join(snapshotDirectory(env), `${snapshot.resetsAt}_${snapshot.usedPercent}.json`);
	const at = (usedPercent: number, observedAt: number, resetsAt = NOW + HALF_WEEK): Snapshot => ({ usedPercent, resetsAt, observedAt });

	test("lives under XDG_STATE_HOME, else ~/.local/state", () => {
		expect(snapshotDirectory({ XDG_STATE_HOME: "/state" })).toBe("/state/agentic/quota/claude-seven-day");
		expect(snapshotDirectory({})).toEndWith("/.local/state/agentic/quota/claude-seven-day");
		expect(snapshotDirectory({ XDG_STATE_HOME: "" })).toEndWith("/.local/state/agentic/quota/claude-seven-day");
	});

	test("is written whole and private, keeping one entry", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordSnapshot(halfway(7), env);
		recordSnapshot(halfway(8), env);
		expect(readSnapshot(env)).toEqual(halfway(8));
		expect(statSync(entryOf(env, halfway(8))).mode & 0o777).toBe(0o600);
		expect(statSync(snapshotDirectory(env)).mode & 0o777).toBe(0o700);
		expect(readdirSync(snapshotDirectory(env))).toEqual([`${NOW + HALF_WEEK}_8.json`]);
	});

	// An idle session keeps rendering its last, lower usage with a fresh clock; within a week only a rise counts.
	test("a lower view in the same week is ignored and keeps the old observedAt", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordSnapshot(at(60, NOW), env);
		recordSnapshot(at(30, NOW + 60), env);
		expect(readSnapshot(env)).toEqual(at(60, NOW));
		expect(readdirSync(snapshotDirectory(env))).toEqual([`${NOW + HALF_WEEK}_60.json`]);
	});

	test("an equal view refreshes observedAt and a higher one raises the usage", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordSnapshot(at(60, NOW), env);
		recordSnapshot(at(60, NOW + 60), env);
		expect(readSnapshot(env)).toEqual(at(60, NOW + 60));
		recordSnapshot(at(70, NOW + 120), env);
		expect(readSnapshot(env)).toEqual(at(70, NOW + 120));
		expect(readdirSync(snapshotDirectory(env))).toEqual([`${NOW + HALF_WEEK}_70.json`]);
	});

	test("a later week replaces the record and an earlier one is ignored", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordSnapshot(at(60, NOW), env);
		const nextWeek = at(5, NOW + 60, NOW + HALF_WEEK + 3600);
		recordSnapshot(nextWeek, env);
		expect(readSnapshot(env)).toEqual(nextWeek);
		recordSnapshot(at(80, NOW + 120), env);
		expect(readSnapshot(env)).toEqual(nextWeek);
		expect(readdirSync(snapshotDirectory(env))).toEqual([`${NOW + HALF_WEEK + 3600}_5.json`]);
	});

	// Two racing writers that both read the old record each write their own entry, so neither can replace
	// the other's: the reader takes the greater, and the next write removes the lower.
	test("entries left by racing writers resolve to the greater", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordSnapshot(at(50, NOW), env);
		writeFileSync(entryOf(env, at(55, NOW + 1)), JSON.stringify(at(55, NOW + 1)), { mode: 0o600 });
		writeFileSync(entryOf(env, at(60, NOW + 1)), JSON.stringify(at(60, NOW + 1)), { mode: 0o600 });
		expect(readSnapshot(env)).toEqual(at(60, NOW + 1));
		recordSnapshot(at(55, NOW + 60), env);
		expect(readSnapshot(env)).toEqual(at(60, NOW + 1));
		recordSnapshot(at(60, NOW + 120), env);
		expect(readdirSync(snapshotDirectory(env))).toEqual([`${NOW + HALF_WEEK}_60.json`]);
	});

	test("a failed rename removes its temporary file and leaves no snapshot", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const entry = entryOf(env, halfway(7));
		mkdirSync(join(entry, "occupied"), { recursive: true });
		expect(() => recordSnapshot(halfway(7), env)).toThrow();
		expect(readdirSync(snapshotDirectory(env))).toEqual([basename(entry)]);
		expect(readdirSync(dirname(snapshotDirectory(env)))).toEqual(["claude-seven-day"]);
		expect(readSnapshot(env)).toEqual({ unreadable: `${entry} is not a regular file` });
	});

	test("a temporary file already at its path is refused and left alone", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		mkdirSync(snapshotDirectory(env), { recursive: true });
		const planted = temporaryOf(env);
		writeFileSync(planted, "planted");
		expect(() => recordSnapshot(halfway(7), env)).toThrow();
		expect(readFileSync(planted, "utf8")).toBe("planted");
		expect(readSnapshot(env)).toBeUndefined();
	});

	// A render killed between creating its temporary file and renaming it leaves the file behind, and nothing
	// removes it: however many pile up, the record must stay readable and writable.
	test("temporary files left by killed renders neither hide the record nor block a write", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordSnapshot(halfway(7), env);
		const parent = dirname(snapshotDirectory(env));
		for (let index = 0; index <= SNAPSHOT_ENTRIES_MAX; index += 1) {
			writeFileSync(join(parent, `.claude-seven-day.${900_000 + index}.tmp`), "");
			writeFileSync(join(snapshotDirectory(env), `.${900_000 + index}.tmp`), "");
		}
		expect(pace(readSnapshot(env), NOW)).toMatchObject({ state: "under", usedPercent: 7 });
		recordSnapshot(halfway(8), env);
		expect(readSnapshot(env)).toEqual(halfway(8));
		expect(readdirSync(snapshotDirectory(env)).filter(name => name.endsWith(".json"))).toEqual([`${NOW + HALF_WEEK}_8.json`]);
	});

	// A missing directory is nothing recorded; every other failure is an unreadable store, so a wedged store
	// reads differently from an empty one.
	test("tells a missing record from an oversized, malformed, mislabeled, or irregular entry", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const entry = entryOf(env, halfway(7));
		expect(readSnapshot(env)).toBeUndefined();
		mkdirSync(snapshotDirectory(env), { recursive: true });
		expect(readSnapshot(env)).toBeUndefined();
		writeFileSync(entry, JSON.stringify(halfway(7)).padEnd(SNAPSHOT_MAX_BYTES + 1, " "));
		expect(readSnapshot(env)).toEqual({ unreadable: `${entry} is larger than ${SNAPSHOT_MAX_BYTES} bytes` });
		writeFileSync(entry, "not json");
		expect(readSnapshot(env)).toEqual({ unreadable: `${entry} is not a snapshot of one seven-day window` });
		writeFileSync(entry, JSON.stringify(halfway(8)));
		expect(readSnapshot(env)).toEqual({ unreadable: `${entry} disagrees with its name` });
		rmSync(entry);
		mkdirSync(entry);
		expect(readSnapshot(env)).toEqual({ unreadable: `${entry} is not a regular file` });
		rmSync(entry, { recursive: true });
		expect(spawnSync("mkfifo", [entry]).status).toBe(0);
		// A FIFO with no writer would block a plain read forever, and it stats as size 0: the regular-file check
		// must answer first.
		expect(readSnapshot(env)).toEqual({ unreadable: `${entry} is not a regular file` });
	});

	test("a state path that is not a directory is unreadable, not empty", () => {
		const home = stateHome();
		writeFileSync(join(home, "agentic"), "a file where the state directory should be");
		expect(readSnapshot({ XDG_STATE_HOME: home })).toMatchObject({ unreadable: expect.stringContaining("ENOTDIR") });
	});

	test("ignores names it would not write and counts only entries toward the cap", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		recordSnapshot(halfway(7), env);
		for (const name of [`${NOW + HALF_WEEK}_07.json`, `${NOW + HALF_WEEK}_101.json`, `${NOW + HALF_WEEK}_9.json.tmp`, "0_9.json", "x_9.json"]) {
			writeFileSync(join(snapshotDirectory(env), name), JSON.stringify(halfway(9)));
		}
		for (let index = 0; index < SNAPSHOT_ENTRIES_MAX; index += 1) writeFileSync(join(snapshotDirectory(env), `filler-${index}`), "");
		expect(readSnapshot(env)).toEqual(halfway(7));
		// The record plus SNAPSHOT_ENTRIES_MAX earlier-week entries is one past the cap.
		for (let index = 1; index <= SNAPSHOT_ENTRIES_MAX; index += 1) {
			writeFileSync(entryOf(env, at(1, NOW - index, NOW + HALF_WEEK - index)), JSON.stringify(at(1, NOW - index, NOW + HALF_WEEK - index)));
		}
		expect(readSnapshot(env)).toEqual({ unreadable: `more than ${SNAPSHOT_ENTRIES_MAX} entries in ${snapshotDirectory(env)}` });
		expect(() => recordSnapshot(halfway(8), env)).toThrow(`more than ${SNAPSHOT_ENTRIES_MAX} entries`);
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

	test("an unreadable store reads unknown with its own reason", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		mkdirSync(join(snapshotDirectory(env), `${Math.floor(Date.now() / 1000) + HALF_WEEK}_7.json`), { recursive: true });
		const result = run(["pace"], env);
		expect(result.status).toBe(PACE_EXIT.unknown);
		expect(result.stdout.toString()).toStartWith("unknown (the recorded rate limits are unreadable: ");
	});

	// Every open session keeps rendering its own last response: a stale lower view must not flip the reading.
	test("a lower view rendered later does not lower the reading", () => {
		const env = { XDG_STATE_HOME: stateHome() };
		const now = Math.floor(Date.now() / 1000);
		const week = { resetsAt: now - HALF_WEEK + WINDOW_SECONDS, observedAt: now };
		recordSnapshot({ usedPercent: 60, ...week }, env);
		recordSnapshot({ usedPercent: 30, ...week }, env);
		const result = run(["pace", "--json"], env);
		expect(result.status).toBe(PACE_EXIT.over);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ state: "over", usedPercent: 60 });
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
