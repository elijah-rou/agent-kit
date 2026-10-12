import { describe, expect, test } from "bun:test";
import { applyModes, decide, digestQuestion, explicitCommand, NOTE_QUESTION, noteFor, parseAnswers, POLICY, QUESTIONS, sessionFor, type Answers, type Calibration, type Level, type NoteId, type Policy, type Route } from "./route.ts";

const answers = (level: Level, levelConfidence: number, door: Answers["door"]["choice"] = "reversible", doorConfidence = 0.95): Answers => ({
	door: { choice: door, confidence: doorConfidence, probabilities: { reversible: 0, experiment: 0, "one-way-door": 0, [door]: doorConfidence } },
	level: { choice: level, confidence: levelConfidence, probabilities: { lookup: 0, rigor: 0, loop: 0, [level]: levelConfidence } },
	model: "jev-1.13.0",
});

const SKILL = "/kit/skills/background-run/SKILL.md";

describe("decide", () => {
	test("follows the decision table", () => {
		const oneWay = { choice: "one-way-door", confidence: 0.99 } as const;
		const unsure = { choice: "reversible", confidence: 0.6 } as const;
		expect(decide(answers("lookup", 0.97), POLICY)).toEqual({ advised: { level: "lookup" } });
		expect(decide(answers("lookup", 0.97, "one-way-door", 0.99), POLICY)).toEqual({ advised: { level: "rigor", door: oneWay }, fallback: "conflict" });
		expect(decide(answers("lookup", 0.97, "reversible", 0.6), POLICY)).toEqual({ advised: { level: "rigor", door: unsure }, fallback: "conflict" });
		expect(decide(answers("loop", 0.97), POLICY)).toEqual({ advised: { level: "loop" } });
		expect(decide(answers("loop", 0.97, "one-way-door", 0.99), POLICY)).toEqual({ advised: { level: "loop", door: oneWay } });
		expect(decide(answers("rigor", 0.99), POLICY)).toEqual({ advised: { level: "rigor" } });
		expect(decide(answers("rigor", 0.99, "one-way-door", 0.99), POLICY)).toEqual({ advised: { level: "rigor", door: oneWay } });
		expect(decide(answers("lookup", 0.89), POLICY)).toEqual({ advised: { level: "rigor" }, fallback: "low-confidence" });
		expect(decide(answers("loop", 0.5, "reversible", 0.6), POLICY)).toEqual({ advised: { level: "rigor", door: unsure }, fallback: "low-confidence" });
	});

	test("a level at its threshold counts, and a door answer at its threshold is not unsure", () => {
		expect(decide(answers("lookup", 0.9), POLICY).advised).toEqual({ level: "lookup" });
		expect(decide(answers("rigor", 0.99, "experiment", 0.8), POLICY).advised).toEqual({ level: "rigor" });
		expect(decide(answers("rigor", 0.99, "experiment", 0.79), POLICY).advised).toEqual({ level: "rigor", door: { choice: "experiment", confidence: 0.79 } });
	});

	test("a confidence outside [0, 1] is a programmer error", () => {
		expect(() => decide(answers("lookup", 1.2), POLICY)).toThrow("outside [0, 1]");
		expect(() => decide(answers("lookup", 0.9, "reversible", Number.NaN), POLICY)).toThrow("not finite");
	});
});

const calibrated = (threshold: number): Calibration => ({ threshold, questionsDigest: digestQuestion(QUESTIONS.level), model: "jev-1.13.0", samples: 200, positives: 20, precision: 0.95, recall: 0.8, date: "2026-10-30", source: "test" });
const ADVISORY: Policy = { ...POLICY, notes: { ...POLICY.notes, lookup: { mode: "advisory", calibration: calibrated(0.9) }, loop: { mode: "advisory", calibration: calibrated(0.9) } } };
const door = { choice: "one-way-door", confidence: 0.99 } as const;

describe("applyModes", () => {
	test("delivers only advisory notes: lookup and loop start in shadow, the door note acts", () => {
		expect(applyModes({ level: "lookup" }, POLICY, "policy", "jev-1.13.0")).toEqual({ delivered: { level: "rigor" } });
		expect(applyModes({ level: "loop", door }, POLICY, "policy", "jev-1.13.0")).toEqual({ delivered: { level: "rigor", door } });
		expect(applyModes({ level: "rigor", door }, POLICY, "policy", "jev-1.13.0")).toEqual({ delivered: { level: "rigor", door } });
		expect(applyModes({ level: "lookup" }, ADVISORY, "policy", "jev-1.13.0")).toEqual({ delivered: { level: "lookup" } });
		expect(applyModes({ level: "loop", door }, ADVISORY, "policy", "jev-1.13.0")).toEqual({ delivered: { level: "loop", door } });
	});

	test("a session can only lower notes", () => {
		expect(sessionFor(undefined)).toBe("policy");
		expect(sessionFor(" ")).toBe("policy");
		expect(sessionFor("off")).toBe("off");
		expect(sessionFor("shadow")).toBe("shadow");
		expect(sessionFor("advisory")).toBe("shadow");
		for (const session of ["shadow", "off"] as const) {
			expect(applyModes({ level: "rigor", door }, ADVISORY, session, "jev-1.13.0")).toEqual({ delivered: { level: "rigor" } });
			expect(applyModes({ level: "lookup" }, ADVISORY, session, "jev-1.13.0")).toEqual({ delivered: { level: "rigor" } });
		}
	});

	test("a level note measured on another model drops to shadow, and the door note stays", () => {
		expect(applyModes({ level: "lookup" }, ADVISORY, "policy", "jev-1.14.0")).toEqual({ delivered: { level: "rigor" }, fallback: "model-drift" });
		expect(applyModes({ level: "loop", door }, ADVISORY, "policy", "jev-1.14.0")).toEqual({ delivered: { level: "rigor", door }, fallback: "model-drift" });
		expect(applyModes({ level: "rigor", door }, ADVISORY, "policy", "jev-1.14.0")).toEqual({ delivered: { level: "rigor", door } });
	});
});

describe("noteFor", () => {
	test("plain rigor adds nothing, and the door note keeps its calibrated wording", () => {
		expect(noteFor({ level: "rigor" }, SKILL)).toBeUndefined();
		expect(noteFor({ level: "rigor", door }, SKILL)).toBe(
			"Task-class hint, advisory: Jev classifies it as a one-way door (confidence 0.99). Before building, check the task against the one-way-door list in your instructions; if it is one, compare design shapes with design-checkpoint first.",
		);
		expect(noteFor({ level: "rigor", door: { choice: "experiment", confidence: 0.5 } }, SKILL)).toContain("Jev is unsure (experiment, confidence 0.50).");
	});

	test("lookup answers directly, and loop points at background-run without invoking a landing mode", () => {
		const lookup = noteFor({ level: "lookup" }, SKILL)!;
		expect(lookup).toContain("Answer directly");
		const loop = noteFor({ level: "loop" }, SKILL)!;
		expect(loop).toContain(`read the background-run skill at ${SKILL}`);
		expect(loop).toContain("This invokes no landing mode.");
		expect(noteFor({ level: "loop", door }, SKILL)).toBe(`${loop}\n\n${noteFor({ level: "rigor", door }, SKILL)}`);
		expect(() => noteFor({ level: "loop" }, "/kit/skills/background-run")).toThrow("not a skill file");
	});

	test("every note leaves precedence to the user and names no runtime", () => {
		const routes: Route[] = [{ level: "lookup" }, { level: "loop", door }, { level: "rigor", door }];
		for (const route of routes) {
			const note = noteFor(route, SKILL)!;
			expect(note).not.toMatch(/\b(?:Claude|Codex|Pi)\b/);
			if (route.level !== "rigor") expect(note).toContain("The user's words and your instructions take precedence over this note.");
		}
	});
});

describe("calibration", () => {
	test("an advisory note was calibrated on today's question wording", () => {
		for (const [id, note] of Object.entries(POLICY.notes) as [NoteId, Policy["notes"][NoteId]][]) {
			if (note.mode !== "advisory") continue;
			expect(`${id}: ${note.calibration.questionsDigest}`).toBe(`${id}: ${digestQuestion(QUESTIONS[NOTE_QUESTION[id]])}`);
		}
	});

	test("the digest follows wording, not key order", () => {
		const reordered = { criteria: QUESTIONS.door.criteria, instructions: QUESTIONS.door.instructions, type: QUESTIONS.door.type };
		expect(digestQuestion(reordered)).toBe(digestQuestion(QUESTIONS.door));
		const reworded = { ...QUESTIONS.door, instructions: `${QUESTIONS.door.instructions} ` };
		expect(digestQuestion(reworded)).not.toBe(digestQuestion(QUESTIONS.door));
	});
});

describe("parseAnswers", () => {
	const wire = {
		door: { type: "choice", choice: "reversible", confidence: 0.98, probabilities: { reversible: 0.99, experiment: 0.01, "one-way-door": 0 } },
		level: { type: "choice", choice: "lookup", confidence: 0.97, probabilities: { lookup: 0.97, rigor: 0.03, loop: 0 } },
	};

	test("accepts both questions' choice answers and keeps their probabilities", () => {
		expect(parseAnswers("jev-1.13.0", wire)).toEqual({
			door: { choice: "reversible", confidence: 0.98, probabilities: { reversible: 0.99, experiment: 0.01, "one-way-door": 0 } },
			level: { choice: "lookup", confidence: 0.97, probabilities: { lookup: 0.97, rigor: 0.03, loop: 0 } },
			model: "jev-1.13.0",
		});
	});

	test("rejects a missing model, an unknown choice, an out-of-range number, or a missing probability", () => {
		expect(parseAnswers(undefined, wire)).toBeUndefined();
		expect(parseAnswers("", wire)).toBeUndefined();
		expect(parseAnswers("m".repeat(65), wire)).toBeUndefined();
		expect(parseAnswers("m", { door: wire.door })).toBeUndefined();
		expect(parseAnswers("m", { ...wire, level: { ...wire.level, choice: "poteto" } })).toBeUndefined();
		expect(parseAnswers("m", { ...wire, door: { ...wire.door, confidence: 1.5 } })).toBeUndefined();
		expect(parseAnswers("m", { ...wire, level: { ...wire.level, probabilities: { lookup: 0.97, rigor: 0.03 } } })).toBeUndefined();
		expect(parseAnswers("m", { ...wire, level: { ...wire.level, type: "noul" } })).toBeUndefined();
	});
});

describe("explicitCommand", () => {
	test("a leading slash command or skill mention is the user's choice; paths and variables are not", () => {
		expect(explicitCommand("/background-run fix the flaky session tests until CI is green")).toEqual({ command: "background-run", rest: "fix the flaky session tests until CI is green" });
		expect(explicitCommand("/skill:background-run keep going")).toEqual({ command: "skill:background-run", rest: "keep going" });
		expect(explicitCommand("$background-run keep going")).toEqual({ command: "background-run", rest: "keep going" });
		expect(explicitCommand("/compact")).toEqual({ command: "compact", rest: "" });
		expect(explicitCommand(`${"/" + "Users/someone"}/app crashes on start`)).toBeUndefined();
		expect(explicitCommand("$HOME is wrong in the launcher")).toBeUndefined();
		expect(explicitCommand("fix the /etc/hosts entry")).toBeUndefined();
	});
});
