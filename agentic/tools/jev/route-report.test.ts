import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, CORRELATION_CAVEAT, DAY_MS, formatReport, parseRecord, PI_NOTED_CAVEAT, readCorrections, readLedger, type LedgerRead, type ReportInput, type ReportRuntime } from "./route-report.ts";
import type { RouteRecord } from "./route-task.ts";
import type { Answers, Level, Route } from "./route.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const CLI = join(import.meta.dir, "cli.ts");
const oneWay = { choice: "one-way-door", confidence: 0.99 } as const;

const answers = (level: Level, levelConfidence: number, door: Answers["door"]["choice"] = "reversible", doorConfidence = 0.95): Answers => ({
	door: { choice: door, confidence: doorConfidence, probabilities: { reversible: 0, experiment: 0, "one-way-door": 0, [door]: doorConfidence } },
	level: { choice: level, confidence: levelConfidence, probabilities: { lookup: 0, rigor: 0, loop: 0, [level]: levelConfidence } },
	model: "jev-1.13.0",
});

/** A record as routeTask writes or once wrote it: runtime is the report's own set, which keeps runtimes the writer has dropped. */
type Fixture = Omit<RouteRecord, "runtime"> & { runtime: ReportRuntime };

let serial = 0;
/** A record; fields default to a classified rigor prompt in o/r one day before NOW. */
function rec(fields: Partial<Fixture> & { delivered: Route }): Fixture {
	serial++;
	return {
		v: 1,
		policy: "task-route@2",
		at: new Date(NOW - DAY_MS + serial * 1000).toISOString(),
		machine: "bananamac",
		runtime: "claude",
		launcher: "direct",
		session: "s-plain",
		repo: "o/r",
		optedOut: false,
		mode: "policy",
		words: 9,
		chars: 50,
		digest: serial.toString(16).padStart(16, "0"),
		noted: false,
		fallbacks: [],
		latencyMs: 400,
		...fields,
	};
}

// One of each way a note can be decided, noted, or withheld, across three runtimes, plus one record of the shadow-era policy.
const RECORDS: Fixture[] = [
	rec({ session: "s-door", answers: answers("rigor", 0.99, "one-way-door", 0.99), advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor", door: oneWay }, noted: true }),
	rec({ session: "s-door", answers: answers("rigor", 0.99, "one-way-door", 0.99), advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor" }, fallbacks: ["queued"] }),
	rec({ session: "s-lookup", answers: answers("lookup", 0.97), advised: { level: "lookup" }, delivered: { level: "lookup" }, noted: true }),
	rec({ session: "s-lookup", answers: answers("lookup", 0.95), advised: { level: "lookup" }, delivered: { level: "rigor" }, fallbacks: ["model-drift"] }),
	rec({ session: "s-plain", policy: "task-route@1", answers: answers("lookup", 0.93), advised: { level: "lookup" }, delivered: { level: "rigor" } }),
	rec({ session: "s-plain", mode: "shadow", answers: answers("lookup", 0.91), advised: { level: "lookup" }, delivered: { level: "rigor" } }),
	rec({ session: "s-plain", answers: answers("lookup", 0.5), advised: { level: "rigor" }, delivered: { level: "rigor" }, fallbacks: ["low-confidence"] }),
	rec({ session: "s-plain", delivered: { level: "rigor" }, fallbacks: ["not-a-task"] }),
	rec({ runtime: "pi", session: "p-loop", answers: answers("loop", 0.96, "one-way-door", 0.99), advised: { level: "loop", door: oneWay }, delivered: { level: "loop", door: oneWay }, noted: true }),
	rec({ runtime: "pi", session: "p-loop", answers: answers("loop", 0.92), advised: { level: "loop" }, delivered: { level: "rigor" }, fallbacks: ["skill-missing"] }),
	rec({ runtime: "pi", session: "p-cmd", answers: answers("loop", 0.94), advised: { level: "loop" }, delivered: { level: "rigor" }, explicit: "background-run", fallbacks: ["explicit-choice"] }),
	rec({ runtime: "codex", session: "c-off", mode: "off", repo: "unknown", delivered: { level: "rigor" }, fallbacks: ["off"] }),
	rec({ session: "elsewhere", repo: "o/other", answers: answers("lookup", 0.99), advised: { level: "lookup" }, delivered: { level: "lookup" }, noted: true }),
	rec({ runtime: "codex", session: "c-lookup", answers: answers("lookup", 0.98), advised: { level: "lookup" }, delivered: { level: "lookup" }, noted: true }),
	rec({ session: "s-unknown", answers: answers("lookup", 0.92), advised: { level: "lookup" }, delivered: { level: "rigor" } }),
	rec({ session: "s-door", answers: answers("lookup", 0.97, "one-way-door", 0.99), advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor" }, fallbacks: ["conflict", "queued"] }),
];
const TRIAL = RECORDS.filter((r) => r.policy === "task-route@2");
const OLD = rec({ session: "s-old", at: new Date(NOW - 8 * DAY_MS).toISOString(), answers: answers("lookup", 0.99), advised: { level: "lookup" }, delivered: { level: "lookup" }, noted: true });

function ledgerDir(): string {
	const root = mkdtempSync(join(tmpdir(), "route-report-"));
	const lines = (records: Fixture[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
	mkdirSync(join(root, "bananamac"));
	mkdirSync(join(root, "bananaarch"));
	writeFileSync(join(root, "bananamac", "claude-s.jsonl"), lines([...RECORDS.filter((r) => r.runtime === "claude"), OLD]) + "not json\n" + '{"v":2}\n');
	writeFileSync(join(root, "bananamac", "codex-c-off.jsonl"), lines(RECORDS.filter((r) => r.runtime === "codex")));
	// A ledger copied from another machine repeats one of these records.
	writeFileSync(join(root, "bananaarch", "pi-p.jsonl"), lines([...RECORDS.filter((r) => r.runtime === "pi"), RECORDS[0]!]));
	writeFileSync(join(root, "bananaarch", "notes.txt"), "not a ledger file\n");
	return root;
}

function correctionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "route-corrections-"));
	const correction = (session: string) => ({ kind: "repo", class: "some-class", correction: "SECRET USER WORDS", text: "a rule", evidence: { session, date: "2026-10-20" } });
	writeFileSync(join(dir, "s-door.json"), JSON.stringify([correction("s-door"), correction("s-door")]));
	writeFileSync(join(dir, "s-plain.json"), JSON.stringify([correction("s-plain")]));
	writeFileSync(join(dir, "elsewhere.json"), JSON.stringify([correction("elsewhere")]));
	writeFileSync(join(dir, "gone.json"), JSON.stringify([correction("gone"), { kind: "repo" }]));
	writeFileSync(join(dir, "broken.json"), "{");
	return dir;
}

const report = (ledger: LedgerRead = readLedger(ledgerDir()), corrections: ReportInput["corrections"] = { kind: "read", read: readCorrections(correctionsDir()), repo: "o/r" }, policy = "task-route@2") =>
	buildReport({ ledger, corrections, now: NOW, days: 7, policy });

describe("readLedger", () => {
	test("reads every machine's files, skips unreadable lines and copied duplicates", () => {
		const ledger = readLedger(ledgerDir());
		expect([ledger.files, ledger.records.length, ledger.malformed, ledger.duplicates]).toEqual([3, RECORDS.length + 1, 2, 1]);
	});

	test("a missing ledger is empty, not an error", () => {
		expect(readLedger("/nowhere/task-route")).toEqual({ root: "/nowhere/task-route", files: 0, records: [], malformed: 0, duplicates: 0 });
	});

	test("a record is read as the report's own view of it", () => {
		const first = RECORDS[0]!;
		expect(parseRecord(JSON.stringify(first))).toEqual({
			policy: "task-route@2",
			at: first.at,
			machine: "bananamac",
			runtime: "claude",
			session: "s-door",
			repo: "o/r",
			mode: "policy",
			digest: first.digest,
			answers: { door: { choice: "one-way-door", confidence: 0.99 }, level: { choice: "rigor", confidence: 0.99 }, model: "jev-1.13.0" },
			advised: { level: "rigor", door: { choice: "one-way-door" } },
			delivered: { level: "rigor", door: { choice: "one-way-door" } },
			noted: true,
			fallbacks: [],
		});
	});

	test("a codex record still parses, whatever runtimes the writer names now", () => {
		const codex = RECORDS.find((r) => r.session === "c-lookup")!;
		expect(parseRecord(JSON.stringify(codex))).toMatchObject({ runtime: "codex", session: "c-lookup", noted: true });
	});

	test("a line with an unknown runtime, a bad date, a malformed route, or no policy, machine, or digest is not a record", () => {
		const bads = [{ runtime: "vim" }, { at: "yesterday" }, { delivered: { level: "nap" } }, { noted: "yes" }, { answers: { door: {} } }, { policy: undefined }, { machine: undefined }, { digest: undefined }, { policy: "" }, { machine: 7 }];
		for (const bad of bads) expect(parseRecord(JSON.stringify({ ...RECORDS[0], ...bad }))).toBeUndefined();
		const ledger = mkdtempSync(join(tmpdir(), "route-report-bad-"));
		mkdirSync(join(ledger, "bananamac"));
		writeFileSync(join(ledger, "bananamac", "claude-s.jsonl"), bads.map((bad) => JSON.stringify({ ...RECORDS[0], ...bad })).join("\n") + "\n");
		expect(readLedger(ledger)).toMatchObject({ records: [], malformed: bads.length });
	});
});

describe("buildReport", () => {
	test("keeps only the window and the shown policy, and counts the other policies apart", () => {
		const r = report();
		expect(r.window).toEqual({ since: "2026-10-14T12:00:00.000Z", until: "2026-10-21T12:00:00.000Z", days: 7 });
		expect(r.ledger).toMatchObject({ inWindow: RECORDS.length, outsideWindow: 1, malformed: 2, duplicates: 1 });
		expect(r.policy).toEqual({ shown: "task-route@2", records: TRIAL.length, others: { "task-route@1": 1 } });
		expect(r.machines).toEqual({ bananamac: TRIAL.length });
		expect(() => buildReport({ ledger: readLedger("/nowhere"), corrections: { kind: "none", reason: "x" }, now: NOW, days: 0, policy: "task-route@2" })).toThrow("days must be an integer");
	});

	test("shows a shadow-era policy only when asked, where a note withheld without a fallback is unknown", () => {
		const r = report(undefined, undefined, "task-route@1");
		expect(r.policy).toEqual({ shown: "task-route@1", records: 1, others: { "task-route@2": TRIAL.length } });
		expect(r.notes.filter((row) => row.decided > 0)).toEqual([{ note: "lookup", runtime: "claude", decided: 1, noted: 0, withheld: 1, reasons: { unknown: 1 } }]);
		if (r.corrections.kind !== "counted") throw new Error("expected counted corrections");
		expect(r.corrections.unmatched).toBe(4);
		expect(r.corrections.rows.find((row) => row.group === "no note")).toEqual({ group: "no note", sessions: 1, corrected: 1, corrections: 1 });
	});

	test("counts prompts, classifications, notes, and every fallback per runtime", () => {
		expect(report().runtimes).toEqual([
			{ runtime: "claude", prompts: 10, classified: 9, noted: 3, fallbacks: { queued: 2, "model-drift": 1, "low-confidence": 1, "not-a-task": 1, conflict: 1 } },
			{ runtime: "codex", prompts: 2, classified: 1, noted: 1, fallbacks: { off: 1 } },
			{ runtime: "pi", prompts: 3, classified: 3, noted: 1, fallbacks: { "skill-missing": 1, "explicit-choice": 1 } },
		]);
	});

	test("splits each note's decisions into noted and withheld, with the reason it was withheld", () => {
		const rows = report().notes.filter((r) => r.decided > 0);
		expect(rows).toEqual([
			// A conflict changed the advised route, so the queued fallback alone explains the withheld door note.
			{ note: "door", runtime: "claude", decided: 3, noted: 1, withheld: 2, reasons: { queued: 2 } },
			{ note: "door", runtime: "pi", decided: 1, noted: 1, withheld: 0, reasons: {} },
			{ note: "lookup", runtime: "claude", decided: 5, noted: 2, withheld: 3, reasons: { "model-drift": 1, "session-shadow": 1, unknown: 1 } },
			{ note: "lookup", runtime: "codex", decided: 1, noted: 1, withheld: 0, reasons: {} },
			{ note: "loop", runtime: "pi", decided: 3, noted: 1, withheld: 2, reasons: { "skill-missing": 1, "explicit-choice": 1 } },
		]);
		expect(report().notes.filter((r) => r.decided === 0).map((r) => `${r.note}/${r.runtime}`)).toEqual(["door/codex", "lookup/pi", "loop/claude", "loop/codex"]);
	});

	test("gives each answer's share of the runtime's classified prompts and its median confidence", () => {
		const level = report().answers.filter((r) => r.question === "level" && r.runtime === "claude");
		expect(level).toEqual([
			{ question: "level", choice: "lookup", runtime: "claude", count: 7, share: 7 / 9, medianConfidence: 0.95 },
			{ question: "level", choice: "rigor", runtime: "claude", count: 2, share: 2 / 9, medianConfidence: 0.99 },
		]);
		expect(report().answers.filter((r) => r.question === "door" && r.runtime === "pi").map((r) => [r.choice, r.count])).toEqual([["one-way-door", 1], ["reversible", 2]]);
	});

	test("counts corrections in this repository's sessions that got a note, apart from those that did not", () => {
		const c = report().corrections;
		expect(c).toMatchObject({ kind: "counted", repo: "o/r", records: 5, unmatched: 2, malformed: 2, caveat: CORRELATION_CAVEAT });
		if (c.kind !== "counted") throw new Error("expected counted corrections");
		expect(c.rows).toEqual([
			{ group: "a door note", sessions: 2, corrected: 1, corrections: 2 },
			{ group: "a lookup note", sessions: 2, corrected: 0, corrections: 0 },
			{ group: "a loop note", sessions: 1, corrected: 0, corrections: 0 },
			{ group: "any note", sessions: 4, corrected: 1, corrections: 2 },
			{ group: "no note", sessions: 3, corrected: 1, corrections: 1 },
		]);
	});
});

describe("formatReport", () => {
	test("prints plain tables, labels corrections as correlation, and never prints correction text", () => {
		const text = formatReport(report());
		expect(text).toContain("Task-route report, 2026-10-14 to 2026-10-21 (7 days)");
		expect(text).toContain("Policy: task-route@2, 15 records in the window. Records of other policies: task-route@1 1 (not counted below; --policy <id> shows one).");
		expect(text.split("\n")).toContain("  lookup  claude   5        2      3         model-drift 1, session-shadow 1, unknown 1");
		expect(text).toContain(PI_NOTED_CAVEAT);
		expect(text).toContain("Corrections in this repository's sessions (recorded as o/r), from ");
		expect(text).toContain(CORRELATION_CAVEAT);
		expect(text).not.toContain("SECRET USER WORDS");
		expect(formatReport(report(undefined, { kind: "none", reason: "not in a git repository" }))).toContain("Corrections: not in a git repository.");
	});
});

describe("agentic jev route-report", () => {
	function repoWithCorrections(): string {
		const repo = mkdtempSync(join(tmpdir(), "route-report-repo-"));
		const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		git("init", "-q");
		git("remote", "add", "origin", "https://github.com/o/r.git");
		const dir = join(repo, ".git", "agentic", "corrections");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "s-door.json"), JSON.stringify([{ kind: "repo", class: "c", correction: "x", text: "y", evidence: { session: "s-door", date: "2026-10-20" } }]));
		return repo;
	}

	test("reads the ledger under XDG_STATE_HOME and the repository's corrections, as a table or JSON", () => {
		const state = mkdtempSync(join(tmpdir(), "route-report-state-"));
		const root = join(state, "agentic", "task-route", "bananamac");
		mkdirSync(root, { recursive: true });
		const recent = RECORDS.map((r) => ({ ...r, at: new Date(Date.now() - DAY_MS).toISOString() }));
		writeFileSync(join(root, "claude-s.jsonl"), recent.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const cwd = repoWithCorrections();
		const env = { ...process.env, XDG_STATE_HOME: state };
		const json = spawnSync("bun", [CLI, "route-report", "--json", "--days", "3"], { cwd, env, encoding: "utf8", timeout: 20_000 });
		expect(json.status).toBe(0);
		const parsed = JSON.parse(json.stdout);
		expect([parsed.window.days, parsed.ledger.inWindow, parsed.policy.shown, parsed.policy.records, parsed.corrections.repo, parsed.corrections.records]).toEqual([3, RECORDS.length, "task-route@2", TRIAL.length, "o/r", 1]);
		const shadowEra = spawnSync("bun", [CLI, "route-report", "--json", "--policy", "task-route@1"], { cwd, env, encoding: "utf8", timeout: 20_000 });
		expect(shadowEra.status).toBe(0);
		expect(JSON.parse(shadowEra.stdout).policy).toEqual({ shown: "task-route@1", records: 1, others: { "task-route@2": TRIAL.length } });
		const plain = spawnSync("bun", [CLI, "route-report"], { cwd, env, encoding: "utf8", timeout: 20_000 });
		expect(plain.status).toBe(0);
		expect(plain.stdout).toContain("(7 days)");
		expect(plain.stdout).toContain(CORRELATION_CAVEAT);
	});

	test("refuses a bad window or policy", () => {
		for (const args of [["--days", "0"], ["--days", "400"], ["--days"], ["--since", "2026-10-01"], ["--policy"], ["--policy", "task-route"], ["--policy", "--json"]]) {
			const result = spawnSync("bun", [CLI, "route-report", ...args], { encoding: "utf8", timeout: 20_000 });
			expect(`${args.join(" ")}: ${result.status}`).toBe(`${args.join(" ")}: 2`);
		}
	});
});
