// Task routing policy task-route@1 (docs/design/jev-task-routing.md). One Jev request per prompt asks
// two questions: door (the one-way-door question calibrated on 2026-10-07) and level (lookup, rigor,
// or loop). decide turns the answers into an advised route, applyModes keeps only the notes the
// policy and the session allow, and noteFor writes fixed note text: no Jev text reaches the model.
// Rigor is the floor the instructions already carry, so it adds no note, and any failure means rigor.
// Everything here is pure.

import { createHash } from "node:crypto";

export const TASK_INSTRUCTIONS = "The state is a software task given to a coding agent. Classify how the agent should approach it.";
export const TASK_CRITERIA = {
	reversible: "An ordinary change that is easy to undo; the agent can just build it and show the result.",
	experiment:
		"There are candidate approaches, or the value is unclear, and building, prototyping, or measuring would settle it before committing.",
	"one-way-door":
		"Hard to reverse: changes a public contract or API, persisted data or file formats, a security boundary, " +
		"hard-to-reverse architecture, or core data structures and the ownership or concurrency model.",
} as const;
export type DoorClass = keyof typeof TASK_CRITERIA;

export const LEVEL_INSTRUCTIONS = "The state is a message a user sent to a coding agent. Classify how much process the agent should apply.";
export const LEVEL_CRITERIA = {
	lookup: "A question or small request answerable directly from reading code, docs, or state, with no change beyond a trivial edit.",
	rigor: "A change, fix, investigation, or design that needs grounding, verification, and review.",
	loop: "The user's own words hand the work off to run without them, or to keep going until a stated condition holds. Length alone does not make a loop.",
} as const;
export type Level = keyof typeof LEVEL_CRITERIA;

/** Both questions go in one request. Changing a wording invalidates its calibration (see digestQuestion). */
export const QUESTIONS = {
	door: { type: "choice", instructions: TASK_INSTRUCTIONS, criteria: TASK_CRITERIA },
	level: { type: "choice", instructions: LEVEL_INSTRUCTIONS, criteria: LEVEL_CRITERIA },
} as const;
export type QuestionId = keyof typeof QUESTIONS;

export type ChoiceAnswer<C extends string> = { choice: C; confidence: number };
/** An answer as Jev gives it; records keep the probabilities so thresholds can be replayed. */
export type ScoredAnswer<C extends string> = ChoiceAnswer<C> & { probabilities: Record<C, number> };
export type Answers = { door: ScoredAnswer<DoorClass>; level: ScoredAnswer<Level>; model: string };

/** The task text, screened and redacted. Only egress.ts mints it. */
export type Sendable = string & { readonly sendable: unique symbol };
export type ClassifyFailure = "classifier-unavailable" | "timeout" | "cancelled" | "error" | "malformed";
export type ClassifyOutcome = { kind: "answered"; answers: Answers } | { kind: "failed"; reason: ClassifyFailure };
/** One request asking QUESTIONS about the state. Never rejects: every failure is an outcome. */
export type Classify = (state: { task: Sendable }, signal: AbortSignal) => Promise<ClassifyOutcome>;

export type DoorNote = ChoiceAnswer<DoorClass>;
/** A lookup carries no door: "a lookup that might be a one-way door" is not a route. */
export type Route = { level: "lookup" } | { level: "rigor"; door?: DoorNote } | { level: "loop"; door?: DoorNote };

/** The evidence that lets a note act. Flipping a note to advisory is a reviewed commit adding one. */
export type Calibration = {
	/** door: the note fires on one-way-door or below this confidence. lookup and loop: the level counts at or above it. */
	threshold: number;
	/** digestQuestion of the question the threshold was measured on. */
	questionsDigest: string;
	/** The answering model the threshold was measured on. */
	model: string;
	samples: number;
	positives: number;
	precision: number;
	recall: number;
	date: string;
	source: string;
};
/** A shadow note is decided and recorded but never delivered, with a provisional threshold. */
export type NotePolicy = { mode: "shadow"; threshold: number } | { mode: "advisory"; calibration: Calibration };
export type NoteId = "door" | "lookup" | "loop";
export type Policy = { id: "task-route"; version: number; deadlineMs: number; notes: Record<NoteId, NotePolicy> };

/** The question each note's threshold applies to. */
export const NOTE_QUESTION: Record<NoteId, QuestionId> = { door: "door", lookup: "level", loop: "level" };

export const POLICY: Policy = {
	id: "task-route",
	version: 1,
	deadlineMs: 3000,
	notes: {
		// agentic evals/jev-risk, second run: 90 hand-labeled tasks asked twice each. 56 of 60 one-way-door
		// calls hinted (2 of 30 tasks missed), and 16 of 120 other calls hinted.
		door: {
			mode: "advisory",
			calibration: {
				threshold: 0.8,
				questionsDigest: "556d4c822c98335d",
				model: "jev-1.13.0",
				samples: 180,
				positives: 60,
				precision: 0.78,
				recall: 0.93,
				date: "2026-10-07",
				source: "elijah-rou/agentic evals/jev-risk",
			},
		},
		lookup: { mode: "shadow", threshold: 0.9 },
		loop: { mode: "shadow", threshold: 0.9 },
	},
};

/** How the session's AGENTIC_ROUTE setting bounds the policy: a session can only lower notes. */
export type Session = "policy" | "shadow" | "off";

export function sessionFor(setting: string | undefined): Session {
	const value = setting?.trim();
	if (!value) return "policy";
	// Any other value lowers to shadow, so a typo can never raise a note.
	return value === "off" ? "off" : "shadow";
}

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(`task-route: ${message}`);
}

function assertConfidence(answer: ChoiceAnswer<string>): void {
	assert(Number.isFinite(answer.confidence), `confidence is not finite: ${answer.confidence}`);
	assert(answer.confidence >= 0 && answer.confidence <= 1, `confidence outside [0, 1]: ${answer.confidence}`);
}

function thresholdOf(note: NotePolicy): number {
	return note.mode === "advisory" ? note.calibration.threshold : note.threshold;
}

/** The door rule as calibrated: a one-way door, or any answer Jev is unsure of. */
export function doorRule(door: DoorNote, policy: Policy): DoorNote | undefined {
	assertConfidence(door);
	const fires = door.choice === "one-way-door" || door.confidence < thresholdOf(policy.notes.door);
	return fires ? { choice: door.choice, confidence: door.confidence } : undefined;
}

function rigor(door: DoorNote | undefined): Route {
	return door ? { level: "rigor", door } : { level: "rigor" };
}

function loop(door: DoorNote | undefined): Route {
	return door ? { level: "loop", door } : { level: "loop" };
}

export type Decision = { advised: Route; fallback?: "conflict" | "low-confidence" };

/** The route the answers advise, before modes. A lookup that the door rule flags is a conflict and becomes rigor. */
export function decide(answers: Answers, policy: Policy): Decision {
	assertConfidence(answers.level);
	const door = doorRule(answers.door, policy);
	const { choice, confidence } = answers.level;
	switch (choice) {
		case "rigor":
			return { advised: rigor(door) };
		case "lookup":
			if (confidence < thresholdOf(policy.notes.lookup)) return { advised: rigor(door), fallback: "low-confidence" };
			if (door) return { advised: rigor(door), fallback: "conflict" };
			return { advised: { level: "lookup" } };
		case "loop":
			if (confidence < thresholdOf(policy.notes.loop)) return { advised: rigor(door), fallback: "low-confidence" };
			return { advised: loop(door) };
		default:
			throw new Error(`task-route: unknown level ${String(choice satisfies never)}`);
	}
}

export type Delivery = { delivered: Route; fallback?: "model-drift" };

/**
 * The route actually delivered: only advisory notes survive, the session can lower every note, and a
 * level note measured on another model drops to shadow. The door note only adds caution, so it stays.
 */
export function applyModes(advised: Route, policy: Policy, session: Session, model: string): Delivery {
	if (session !== "policy") return { delivered: { level: "rigor" } };
	const door = advised.level !== "lookup" && advised.door && policy.notes.door.mode === "advisory" ? advised.door : undefined;
	if (advised.level === "rigor") return { delivered: rigor(door) };
	const note = policy.notes[advised.level];
	if (note.mode !== "advisory") return { delivered: rigor(door) };
	if (note.calibration.model !== model) return { delivered: rigor(door), fallback: "model-drift" };
	return { delivered: advised.level === "lookup" ? { level: "lookup" } : loop(door) };
}

const PRECEDENCE = "The user's words and your instructions take precedence over this note.";

/** The one-way-door hint, worded as it has been since the 2026-10-07 calibration. */
export function doorNote(door: DoorNote): string {
	const confidence = door.confidence.toFixed(2);
	const why = door.choice === "one-way-door" ? `classifies it as a one-way door (confidence ${confidence})` : `is unsure (${door.choice}, confidence ${confidence})`;
	return `Task-class hint, advisory: Jev ${why}. Before building, check the task against the one-way-door list in your instructions; if it is one, compare design shapes with design-checkpoint first.`;
}

/** The note for a delivered route, or undefined for plain rigor. backgroundRunSkill is the path of background-run's SKILL.md. */
export function noteFor(delivered: Route, backgroundRunSkill: string): string | undefined {
	switch (delivered.level) {
		case "lookup":
			return `Task-route note, advisory: Jev rates this a lookup. Answer directly: no plan, subagents, or headings. If it turns out to need a change, treat it as a task. ${PRECEDENCE}`;
		case "loop": {
			assert(backgroundRunSkill.endsWith("SKILL.md"), `not a skill file: ${backgroundRunSkill}`);
			const handoff = `Task-route note, advisory: Jev rates this work the user hands off. If the user's words hand the work off, read the background-run skill at ${backgroundRunSkill} and follow it. This invokes no landing mode. ${PRECEDENCE}`;
			return delivered.door ? `${handoff}\n\n${doorNote(delivered.door)}` : handoff;
		}
		case "rigor":
			return delivered.door ? doorNote(delivered.door) : undefined;
		default:
			throw new Error(`task-route: unknown route ${String(delivered satisfies never)}`);
	}
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
	}
	return value;
}

/** 16 hex digits identifying a question's exact type and wording, independent of key order. */
export function digestQuestion(question: { type: string; instructions: string; criteria: Readonly<Record<string, string>> }): string {
	return createHash("sha256").update(JSON.stringify(canonical(question))).digest("hex").slice(0, 16);
}

const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function scored<C extends string>(raw: unknown, choices: readonly C[]): ScoredAnswer<C> | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const { type, choice, confidence, probabilities } = raw as Record<string, unknown>;
	if (type !== "choice" || !choices.includes(choice as C) || !isProbability(confidence)) return undefined;
	if (typeof probabilities !== "object" || probabilities === null) return undefined;
	const table = probabilities as Record<string, unknown>;
	if (!choices.every((option) => isProbability(table[option]))) return undefined;
	return { choice: choice as C, confidence, probabilities: Object.fromEntries(choices.map((option) => [option, table[option]])) as Record<C, number> };
}

/** Model names such as jev-1.13.0; anything longer, or with other characters, is not an answer. */
export const MODEL_NAME_MAX = 64;
const MODEL_NAME = new RegExp(`^[A-Za-z0-9._:-]{1,${MODEL_NAME_MAX}}$`);

/** Both transports' answers, validated: the HTTP body and Pi's ClassifierResult share this shape. */
export function parseAnswers(model: unknown, answers: unknown): Answers | undefined {
	if (typeof model !== "string" || !MODEL_NAME.test(model) || typeof answers !== "object" || answers === null) return undefined;
	const raw = answers as Record<string, unknown>;
	const door = scored(raw.door, Object.keys(TASK_CRITERIA) as DoorClass[]);
	const level = scored(raw.level, Object.keys(LEVEL_CRITERIA) as Level[]);
	return door && level ? { door, level, model } : undefined;
}

/** A leading slash command (`/name`, `/skill:name`) or skill mention (`$skill-name`) is the user's own choice of mode. */
export function explicitCommand(prompt: string): { command: string; rest: string } | undefined {
	const match = /^\s*(?:\/([A-Za-z][\w:.-]*)|\$([a-z][a-z0-9-]*))(?:\s+([\s\S]*))?$/.exec(prompt);
	if (!match) return undefined;
	return { command: match[1] ?? match[2], rest: (match[3] ?? "").trim() };
}
