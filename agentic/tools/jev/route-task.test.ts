import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptOrigin, type Repo } from "./egress.ts";
import { appendRecord, commandLabel, FIELD_MAX, ledgerFile, machineName, promptDigest, RECORD_MAX_BYTES, routeTask, type RouteDeps, type RouteInput, type RouteRecord } from "./route-task.ts";
import { digestQuestion, doorNote, MODEL_NAME_MAX, POLICY, QUESTIONS, type Answers, type Calibration, type Classify, type Level, type Policy } from "./route.ts";

const SKILLS = join(import.meta.dir, "..", "..", "..", "skills");
const SKILL = join(SKILLS, "background-run", "SKILL.md");
const MIGRATE = "Migrate the Zanzibar ledger store from JSON files to SQLite";

const answers = (level: Level, levelConfidence: number, door: Answers["door"]["choice"] = "reversible", doorConfidence = 0.95, model = "jev-1.13.0"): Answers => ({
	door: { choice: door, confidence: doorConfidence, probabilities: { reversible: 0, experiment: 0, "one-way-door": 0, [door]: doorConfidence } },
	level: { choice: level, confidence: levelConfidence, probabilities: { lookup: 0, rigor: 0, loop: 0, [level]: levelConfidence } },
	model,
});

function harness(options: { answer?: Answers; classify?: Classify; repo?: Repo; env?: Record<string, string>; policy?: Policy; skillsDir?: string } = {}) {
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
		skillsDir: options.skillsDir ?? SKILLS,
	};
	return { deps, calls };
}
const input = (prompt: string, fields: Partial<RouteInput> = {}): RouteInput => ({ prompt, cwd: "/repo", runtime: "claude", sessionId: "s1", origin: "user", queued: false, ...fields });

const calibrated: Calibration = { threshold: 0.9, questionsDigest: digestQuestion(QUESTIONS.level), model: "jev-1.13.0", samples: 200, positives: 20, precision: 0.95, recall: 0.8, date: "2026-10-30", source: "test" };
const doorCalibrated: Calibration = { ...calibrated, threshold: 0.8, questionsDigest: digestQuestion(QUESTIONS.door) };
const SHADOW: Policy = { ...POLICY, notes: { door: { mode: "shadow", threshold: 0.8 }, lookup: { mode: "shadow", threshold: 0.9 }, loop: { mode: "shadow", threshold: 0.9 } } };
const DOOR: Policy = { ...SHADOW, notes: { ...SHADOW.notes, door: { mode: "advisory", calibration: doorCalibrated } } };
const ADVISORY: Policy = { ...DOOR, notes: { ...DOOR.notes, lookup: { mode: "advisory", calibration: calibrated }, loop: { mode: "advisory", calibration: calibrated } } };
const oneWay = { choice: "one-way-door", confidence: 0.99 } as const;

describe("routeTask", () => {
	test("the shipped policy delivers every note as advice and records it", async () => {
		const { deps, calls } = harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99) });
		const shipped = await routeTask(input(MIGRATE), deps);
		expect(calls.classify.length).toBe(1);
		expect(shipped.note).toBe(doorNote(oneWay));
		expect(shipped.record).toMatchObject({ policy: "task-route@2", advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor", door: oneWay }, noted: true, fallbacks: [] });
		const lookup = await routeTask(input("Where does the config loader read XDG paths from?"), harness({ answer: answers("lookup", 0.97, "reversible", 0.95, "jev-latest") }).deps);
		expect(lookup.note).toContain("Task-route note, advisory: Jev rates this a lookup.");
		expect(lookup.record).toMatchObject({ delivered: { level: "lookup" }, noted: true, fallbacks: [] });
		const loop = await routeTask(input("Going to bed, keep fixing the flaky tests until CI is green"), harness({ answer: answers("loop", 0.97) }).deps);
		expect(loop.note).toContain(`suggest \`/background-run\` to the user (its skill is at ${SKILL}, for reference)`);
		expect(loop.record).toMatchObject({ delivered: { level: "loop" }, noted: true, fallbacks: [] });
		const shadow = await routeTask(input(MIGRATE), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), policy: SHADOW }).deps);
		expect(shadow.note).toBeUndefined();
		expect(shadow.record).toMatchObject({ delivered: { level: "rigor" }, noted: false, fallbacks: [] });
	});

	test("a turn the runtime started is recorded as system and never sent", async () => {
		for (const prompt of ["<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>", "Delegated task node:delegated-task:x reached a terminal state. Use task_status with taskId x."]) {
			const { deps, calls } = harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), policy: ADVISORY });
			const routed = await routeTask(input(prompt, { origin: promptOrigin(prompt) }), deps);
			expect(calls.classify).toEqual([]);
			expect(routed.note).toBeUndefined();
			expect(routed.record).toMatchObject({ delivered: { level: "rigor" }, noted: false, fallbacks: ["system"] });
		}
	});

	test("an advisory one-way door gets the door note, while shadow lookup and loop notes are only recorded", async () => {
		const door = await routeTask(input(MIGRATE), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), policy: DOOR }).deps);
		expect(door.note).toBe(doorNote(oneWay));
		expect(door.record).toMatchObject({ advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor", door: oneWay }, noted: true, fallbacks: [] });
		const lookup = await routeTask(input("Where does the config loader read XDG paths from?"), harness({ answer: answers("lookup", 0.97), policy: DOOR }).deps);
		expect(lookup.note).toBeUndefined();
		expect(lookup.record).toMatchObject({ advised: { level: "lookup" }, delivered: { level: "rigor" }, noted: false });
		const loop = await routeTask(input("Going to bed, keep fixing the flaky tests until CI is green"), harness({ answer: answers("loop", 0.97), policy: DOOR }).deps);
		expect(loop.note).toBeUndefined();
		expect(loop.record).toMatchObject({ advised: { level: "loop" }, delivered: { level: "rigor" } });
	});

	test("the record holds answers and counts, never the prompt's text", async () => {
		const { record } = await routeTask(input(MIGRATE, { sessionId: "s".repeat(96) }), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), repo: { slug: "some-long-owner-name/some-long-repository-name", optedOut: false }, env: { T3CODE_CLI_PATH: "/t3" } }).deps);
		const line = JSON.stringify(record);
		for (const word of MIGRATE.split(" ").filter((w) => w.length > 3)) expect(line).not.toContain(word);
		expect(record).toMatchObject({ v: 1, policy: "task-route@2", machine: machineName(), runtime: "claude", launcher: "t3", repo: "some-long-owner-name/some-long-repository-name", optedOut: false, mode: "policy", words: 10, chars: MIGRATE.length, digest: promptDigest(MIGRATE) });
		expect(record.answers?.level.probabilities).toEqual({ lookup: 0, rigor: 0.99, loop: 0 });
		expect(Buffer.byteLength(`${line}\n`)).toBeLessThan(RECORD_MAX_BYTES);
	});

	test("a withheld prompt makes no request and records why", async () => {
		const cases: [RouteInput, Repo | undefined, string][] = [
			[input(`please rotate the deploy token ${"ghp_" + "c".repeat(30)} today`), undefined, "unsafe-input"],
			[input(MIGRATE), { slug: "o/private", optedOut: true }, "opted-out"],
			[input("yes, continue"), undefined, "not-a-task"],
			[input(MIGRATE, { origin: "child" }), undefined, "child"],
			[input(MIGRATE, { origin: "extension" }), undefined, "extension"],
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
		const shadow = await routeTask(input(MIGRATE), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99), env: { AGENTIC_ROUTE: "shadow" }, policy: DOOR }).deps);
		expect(shadow.note).toBeUndefined();
		expect(shadow.record).toMatchObject({ mode: "shadow", advised: { level: "rigor", door: oneWay } });
		expect(shadow.record.delivered).toEqual({ level: "rigor" });
	});

	test("a slash command is the user's choice: its text is classified in shadow and nothing is delivered", async () => {
		const { deps, calls } = harness({ answer: answers("loop", 0.97, "one-way-door", 0.99), policy: ADVISORY });
		const { note, record } = await routeTask(input("/background-run keep fixing the flaky session tests until CI is green"), deps);
		expect(note).toBeUndefined();
		expect(calls.classify).toEqual(["keep fixing the flaky session tests until CI is green"]);
		expect(record).toMatchObject({ explicit: "background-run", advised: { level: "loop", door: oneWay }, delivered: { level: "rigor" }, fallbacks: ["explicit-choice"] });
	});

	test("a typed command is recorded only by an agent-kit skill's name, never as typed text", async () => {
		expect(commandLabel("background-run", SKILLS)).toBe("background-run");
		expect(commandLabel("skill:background-run", SKILLS)).toBe("background-run");
		expect(commandLabel("hunter2hunter2hunter2", SKILLS)).toBe("other");
		expect(commandLabel("../background-run", SKILLS)).toBe("other");
		const { record } = await routeTask(input("/hunter2hunter2hunter2 is my password please rotate it now"), harness({ answer: answers("rigor", 0.99) }).deps);
		expect(record.explicit).toBe("other");
		expect(JSON.stringify(record)).not.toContain("hunter2");
	});

	test("a prompt queued while the agent works is classified and recorded, but gets no note", async () => {
		const { note, record } = await routeTask(input(MIGRATE, { queued: true }), harness({ answer: answers("rigor", 0.99, "one-way-door", 0.99) }).deps);
		expect(note).toBeUndefined();
		expect(record).toMatchObject({ advised: { level: "rigor", door: oneWay }, delivered: { level: "rigor" }, noted: false, fallbacks: ["queued"] });
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
		expect(loop.note).toContain(`suggest \`/background-run\` to the user (its skill is at ${SKILL}, for reference)`);
		const missing = await routeTask(input("Going to bed, keep fixing the flaky tests until CI is green"), harness({ answer: answers("loop", 0.97, "one-way-door", 0.99), policy: ADVISORY, skillsDir: "/nowhere/skills" }).deps);
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

	test("the largest record any accepted input can produce fits the cap, and a larger one is refused", async () => {
		const precise = 0.9876543210987654;
		const tiny = 1.1102230246251565e-16;
		const scored = <C extends string>(choice: C, options: readonly C[]) => ({ choice, confidence: precise, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? precise : tiny])) as Record<C, number> });
		const answer: Answers = { door: scored("one-way-door", ["reversible", "experiment", "one-way-door"] as const), level: scored("loop", ["lookup", "rigor", "loop"] as const), model: "m".repeat(MODEL_NAME_MAX) };
		const repo = { slug: `${"\u00f6".repeat(39)}/${"\u0000".repeat(300)}`, optedOut: false };
		const policy: Policy = { ...ADVISORY, notes: { ...ADVISORY.notes, loop: { mode: "advisory", calibration: { ...calibrated, model: answer.model } } } };
		const long = `Keep going ${"word ".repeat(790)}`.slice(0, 4000);
		const scenarios = [
			await routeTask(input(long, { sessionId: "\u0000\u2028".repeat(500) }), harness({ answer, repo, policy }).deps),
			await routeTask(input(`/${"c".repeat(300)} ${long.slice(0, 3600)}`, { sessionId: "\u0000\u2028".repeat(500) }), harness({ answer, repo, policy }).deps),
		];
		for (const { record } of scenarios) {
			const line = `${JSON.stringify(record)}\n`;
			expect(Buffer.byteLength(line)).toBe(line.length);
			const bytes = Buffer.byteLength(line) + FIELD_MAX.machine - record.machine.length;
			expect(bytes).toBeLessThan(RECORD_MAX_BYTES);
		}
		expect(scenarios[0]!.record.delivered).toEqual({ level: "loop", door: { choice: "one-way-door", confidence: precise } });
		expect(scenarios[1]!.record.explicit).toBe("other");
		const { record } = scenarios[0]!;
		expect(() => appendRecord({ ...record, repo: "r".repeat(RECORD_MAX_BYTES) }, { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "jev-state-")) })).toThrow(`over ${RECORD_MAX_BYTES}`);
	});
});
