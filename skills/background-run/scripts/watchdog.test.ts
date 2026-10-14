import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleScriptString, GRACE_MINUTES, registryDir } from "./watchdog.ts";

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
		expect(notifications(f)[0]).toContain("(last 2026-10-14T10:00:00Z)");
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

	test("an empty or absent registry scans to nothing", () => {
		const f = fixture();
		expect(scanAt(f, "2026-10-14T13:00:00Z")).toEqual({ code: 0, stdout: "", stderr: "" });
	});
});

describe("register and unregister", () => {
	test("register writes one JSON file per run; re-registering resets the notified state", () => {
		const f = fixture();
		row(f, "2026-10-14T10:00:00Z");
		register(f, "2026-10-14T10:00:00Z", ["--title", "Queue"]);
		expect(readdirSync(f.registry)).toEqual(["prog-1.json"]);
		expect(JSON.parse(readFileSync(join(f.registry, "prog-1.json"), "utf8"))).toEqual({ run: "prog-1", log: f.log, intervalMinutes: 60, title: "Queue", registeredAt: "2026-10-14T10:00:00Z" });
		expect(scanAt(f, "2026-10-14T13:00:00Z").stdout).toBe("prog-1\tstale\tnotified\n");

		register(f, "2026-10-14T13:30:00Z");
		// The row is still old, so the re-armed run is stale at once, and notifies again for its new registration.
		expect(scanAt(f, "2026-10-14T13:31:00Z").stdout).toBe("prog-1\tstale\tnotified\n");
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

describe("notify", () => {
	test("works for an unregistered run, after its unregister, and appends one line", () => {
		const f = fixture();
		register(f, "2026-10-14T10:00:00Z", ["--title", "Queue"]);
		expect(run(f, ["unregister", "--run", "prog-1"]).code).toBe(0);
		expect(run(f, ["notify", "--run", "prog-1", "--message", "Paused: three ticks without progress", "--now", "2026-10-14T11:00:00Z"])).toEqual({ code: 0, stdout: "notified prog-1\n", stderr: "" });
		expect(notifications(f)).toEqual(["2026-10-14T11:00:00Z\tprog-1\tPaused: three ticks without progress"]);
	});

	test("the AppleScript literal escapes quotes and backslashes and drops control characters", () => {
		expect(appleScriptString('say "hi" \\ then\nquit')).toBe('"say \\"hi\\" \\\\ then quit"');
	});

	// Compiles and evaluates the literal without displaying anything.
	test.if(process.platform === "darwin")("osascript reads the literal back as the original text", () => {
		const text = 'Run "q" \\ paused; display dialog "x"';
		const result = spawnSync("osascript", ["-e", `return ${appleScriptString(text)}`], { encoding: "utf8" });
		expect(result).toMatchObject({ status: 0, stdout: `${text}\n` });
	});
});

describe("usage", () => {
	const cases: [string, string[]][] = [
		["no command", []],
		["an unknown command", ["status"]],
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
