import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "./egress.ts";
import { appendRecord, ledgerFile, machineName, promptDigest, RECORD_MAX_BYTES, routeTask, type RouteDeps, type RouteInput, type RouteRecord } from "./route-task.ts";
import { digestQuestion, doorNote, POLICY, QUESTIONS, type Answers, type Calibration, type Classify, type Level, type Policy } from "./route.ts";

const SKILL = join(import.meta.dir, "..", "..", "..", "skills", "background-run", "SKILL.md");
const MIGRATE = "Migrate the Zanzibar ledger store from JSON files to SQLite";

const answers = (level: Level, levelConfidence: number, door: Answers["door"]["choice"] = "reversible", doorConfidence = 0.95, model = "jev-1.13.0"): Answers => ({
	door: { choice: door, confidence: doorConfidence, probabilities: { reversible: 0, experiment: 0, "one-way-door": 0, [door]: doorConfidence } },
	level: { choice: level, confidence: levelConfidence, probabilities: { lookup: 0, rigor: 0, loop: 0, [level]: levelConfidence } },
	model,
});

function harness(options: { answer?: Answers; classify?: Classify; repo?: Repo; env?: Record<string, string>; policy?: Policy; skill?: string } = {}) {
	const calls = { classify: [] as string[], repo: 0 };
	const classify: Classify = async (state) => {
		calls.classify.push(state.task);
		return options.answer ? { kind: "answered", answers: options.answer } : { kind: "failed", reason: "error" };
	};
	const deps: RouteDeps = {
		policy: options.policy ?? POLICY,
		classify: options.classify ?? classify,
		repo: async () => (calls.repo++, options.repo ?? { slug: "o/r", optedOut: false }),
		env: options.env ?? {},
		now: Date.now,
		backgroundRunSkill: options.skill ?? SKILL,
	};
	return { deps, calls };
}
const input = (prompt: string, fields: Partial<RouteInput> = {}): RouteInput => ({ prompt, cwd: "/repo", runtime: "claude", sessionId: "s1", child: false, ...fields });

const calibrated: Calibration = { threshold: 0.9, questionsDigest: digestQuestion(QUESTIONS.level), model: "jev-1.13.0", samples: 200, positives: 20, precision: 0.95, recall: 0.8, date: "2026-10-30", source: "test" };
const ADVISORY: Policy = { ...POLICY, notes: { ...POLICY.notes, lookup: { mode: "advisory", calibration: calibrated }, loop: { mode: "advisory", calibration: calibrated } } };
const oneWay = { choice: "one-way-door", confidence: 0.99 } as const;

describe("routeTask", () => {
	test("a one-way door gets the door note, while lookup and loop are only recorded", async () => {
		const door = await routeTask(input(MIGRATE), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99) }).deps);
		expect(door.note).toBe(doorNote(oneWay));
		expect(door.record).toMatchObject({ advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor", door: oneWay }, noted: true, fallbacks: [] });
		const lookup = await routeTask(input("Where does the config loader read XDG paths from?"), harness({ answer: answers("lookup", 0.97) }).deps);
		expect(lookup.note).toBeUndefined();
		expect(lookup.record).toMatchObject({ advised: { level: "lookup" }, delivered: { level: "rigor" }, noted: false });
		const loop = await routeTask(input("Going to bed, keep fixing the flaky tests until CI is green"), harness({ answer: answers("loop", 0.97) }).deps);
		expect(loop.note).toBeUndefined();
		expect(loop.record).toMatchObject({ advised: { level: "loop" }, delivered: { level: "rigor" } });
	});

	test("the record holds answers and counts, never the prompt's text", async () => {
		const { record } = await routeTask(input(MIGRATE, { sessionId: "s".repeat(96) }), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), repo: { slug: "some-long-owner-name/some-long-repository-name", optedOut: false }, env: { T3CODE_CLI_PATH: "/t3" } }).deps);
		const line = JSON.stringify(record);
		for (const word of MIGRATE.split(" ").filter((w) => w.length > 3)) expect(line).not.toContain(word);
		expect(record).toMatchObject({ v: 1, policy: "task-route@1", machine: machineName(), runtime: "claude", launcher: "t3", repo: "some-long-owner-name/some-long-repository-name", optedOut: false, mode: "policy", words: 10, chars: MIGRATE.length, digest: promptDigest(MIGRATE) });
		expect(record.answers?.level.probabilities).toEqual({ lookup: 0, rigor: 0.99, loop: 0 });
		expect(Buffer.byteLength(`${line}\n`)).toBeLessThan(RECORD_MAX_BYTES);
	});

	test("a withheld prompt makes no request and records why", async () => {
		const cases: [RouteInput, Repo | undefined, string][] = [
			[input(`please rotate the deploy token ${"ghp_" + "c".repeat(30)} today`), undefined, "unsafe-input"],
			[input(MIGRATE), { slug: "o/private", optedOut: true }, "opted-out"],
			[input("yes, continue"), undefined, "not-a-task"],
			[input(MIGRATE, { child: true }), undefined, "child"],
		];
		for (const [prompt, repo, reason] of cases) {
			const { deps, calls } = harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), ...(repo ? { repo } : {}) });
			const { note, record } = await routeTask(prompt, deps);
			expect(`${reason}: ${note}`).toBe(`${reason}: undefined`);
			expect(record.fallbacks).toEqual([reason as RouteRecord["fallbacks"][number]]);
			expect(calls.classify).toEqual([]);
		}
	});

	test("AGENTIC_ROUTE=off makes no request and no repository lookup; shadow asks but holds every note back", async () => {
		const off = harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), env: { AGENTIC_ROUTE: "off" } });
		const offResult = await routeTask(input(MIGRATE), off.deps);
		expect(offResult.note).toBeUndefined();
		expect(offResult.record).toMatchObject({ mode: "off", fallbacks: ["off"] });
		expect(off.calls).toEqual({ classify: [], repo: 0 });
		const shadow = await routeTask(input(MIGRATE), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), env: { AGENTIC_ROUTE: "shadow" } }).deps);
		expect(shadow.note).toBeUndefined();
		expect(shadow.record).toMatchObject({ mode: "shadow", advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor" } });
	});

	test("a slash command is the user's choice: its text is classified in shadow and nothing is delivered", async () => {
		const { deps, calls } = harness({ answer: answers("loop", 0.97, "one-way-door", 0.99), policy: ADVISORY });
		const { note, record } = await routeTask(input("/background-run keep fixing the flaky session tests until CI is green"), deps);
		expect(note).toBeUndefined();
		expect(calls.classify).toEqual(["keep fixing the flaky session tests until CI is green"]);
		expect(record).toMatchObject({ explicit: "background-run", advised: { level: "loop", door: oneWay }, delivered: { level: "rigor" }, fallbacks: ["explicit-choice"] });
	});

	test("a classifier that hangs is cut off at the deadline", async () => {
		const hanging: Classify = (_state, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "failed", reason: "timeout" })));
		const started = Date.now();
		const { note, record } = await routeTask(input(MIGRATE), harness({ classify: hanging, policy: { ...POLICY, deadlineMs: 50 } }).deps);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(note).toBeUndefined();
		expect(record.fallbacks).toEqual(["timeout"]);
	});

	test("advisory notes are delivered, and a loop whose skill file is missing falls back to rigor", async () => {
		expect((await routeTask(input("Where does the config loader read XDG paths from?"), harness({ answer: answers("lookup", 0.97), policy: ADVISORY }).deps)).note).toContain("Answer directly");
		const loop = await routeTask(input("Going to bed, keep fixing the flaky tests until CI is green"), harness({ answer: answers("loop", 0.97), policy: ADVISORY }).deps);
		expect(loop.note).toContain(`read the background-run skill at ${SKILL}`);
		const missing = await routeTask(input("Going to bed, keep fixing the flaky tests until CI is green"), harness({ answer: answers("loop", 0.97, "one-way-door", 0.99), policy: ADVISORY, skill: "/nowhere/background-run/SKILL.md" }).deps);
		expect(missing.note).toBe(doorNote(oneWay));
		expect(missing.record).toMatchObject({ delivered: { level: "rigor", door: oneWay }, fallbacks: ["skill-missing"] });
		const drift = await routeTask(input("Where does the config loader read XDG paths from?"), harness({ answer: answers("lookup", 0.97, "reversible", 0.95, "jev-1.14.0"), policy: ADVISORY }).deps);
		expect(drift.note).toBeUndefined();
		expect(drift.record.fallbacks).toEqual(["model-drift"]);
	});
});

describe("the ledger", () => {
	test("each session appends to its own file under the machine's directory", async () => {
		const state = mkdtempSync(join(tmpdir(), "jev-state-"));
		const env = { XDG_STATE_HOME: state };
		const { record } = await routeTask(input(MIGRATE, { sessionId: "../a b" }), harness({ answer: answers("rigor", 0.99) }).deps);
		const file = appendRecord(record, env);
		appendRecord(record, env);
		expect(file).toBe(join(state, "agentic", "task-route", machineName(), "claude-___a_b.jsonl"));
		expect(ledgerFile(record, env)).toBe(file);
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(JSON.stringify(record)));
	});

	test("an oversized record is refused rather than written", async () => {
		const { record } = await routeTask(input(MIGRATE), harness({ answer: answers("rigor", 0.99) }).deps);
		expect(() => appendRecord({ ...record, repo: "r".repeat(RECORD_MAX_BYTES) }, { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "jev-state-")) })).toThrow("over 1024");
	});
});
