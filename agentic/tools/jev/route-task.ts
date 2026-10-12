// One prompt's route: screen it, ask Jev both questions in one request, decide, apply modes, and
// write the note. Every prompt yields a record, including withheld and failed ones, so the ledger
// shows what was not routed and why. Records hold answers and counts, never the prompt's text.
// Nothing here throws into a prompt: adapters catch, and any failure means rigor, which adds no note.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { screen, type Origin, type Repo, type Withheld } from "./egress.ts";
import { applyModes, decide, explicitCommand, noteFor, sessionFor, type Answers, type Classify, type ClassifyFailure, type Policy, type Route, type Session } from "./route.ts";

export type Runtime = "claude" | "codex" | "pi" | "cli";
export type RouteInput = {
	prompt: string;
	cwd: string;
	runtime: Runtime;
	sessionId: string;
	/** Only the user's own words are classified; a child's brief or another extension's text is recorded but never sent. */
	origin: Origin;
	/** Typed while the agent works: a note could not reach this prompt's own turn, so it is classified and recorded only. */
	queued: boolean;
};
export type RouteDeps = {
	policy: Policy;
	classify: Classify;
	repo: (cwd: string, timeoutMs: number) => Promise<Repo>;
	env: Record<string, string | undefined>;
	now: () => number;
	/** agent-kit's skills directory: the loop note points at background-run there, and a typed command is recorded only by a skill's name. */
	skillsDir: string;
	/** Cancels the request, for a prompt the user abandons. */
	signal?: AbortSignal;
};

export type Fallback = Withheld | ClassifyFailure | "off" | "explicit-choice" | "queued" | "conflict" | "low-confidence" | "model-drift" | "skill-missing";

export type RouteRecord = {
	v: 1;
	policy: string;
	at: string;
	machine: string;
	runtime: Runtime;
	launcher: "t3" | "direct";
	session: string;
	repo: string;
	optedOut: boolean;
	explicit?: string;
	mode: Session;
	words: number;
	chars: number;
	digest: string;
	answers?: Answers;
	advised?: Route;
	delivered: Route;
	noted: boolean;
	fallbacks: Fallback[];
	latencyMs: number;
};

/** Every variable-length field is cut to these lengths, so a record of any accepted input fits RECORD_MAX_BYTES. */
export const FIELD_MAX = { machine: 63, session: 128, repo: 140, explicit: 64 } as const;

/** Keeps a record's strings to characters JSON writes as one byte each, cut to max. */
function recordText(text: string, max: number): string {
	return text.replace(/[^A-Za-z0-9._:/-]/g, "_").slice(0, max);
}

/** A typed command for the record: an agent-kit skill's name, or "other", so a record never carries typed text. */
export function commandLabel(command: string, skillsDir: string): string {
	const name = command.startsWith("skill:") ? command.slice("skill:".length) : command;
	return /^[a-z][a-z0-9-]*$/.test(name) && existsSync(join(skillsDir, name, "SKILL.md")) ? name : "other";
}

/** 16 hex digits of the prompt as typed, to join records to transcripts without storing text. */
export function promptDigest(prompt: string): string {
	return createHash("sha256").update(prompt.trim()).digest("hex").slice(0, 16);
}

/** The short, lowercased host name, such as bananamac: the machine the agent runs on. */
export function machineName(): string {
	const name = recordText((hostname().split(".")[0] ?? "").toLowerCase(), FIELD_MAX.machine);
	return name.length > 0 ? name : "unknown";
}

export async function routeTask(input: RouteInput, deps: RouteDeps): Promise<{ note?: string; record: RouteRecord }> {
	const { policy } = deps;
	const started = deps.now();
	const left = () => started + policy.deadlineMs - deps.now();
	const mode = sessionFor(deps.env.AGENTIC_ROUTE);
	const explicit = explicitCommand(input.prompt);
	const repo = mode === "off" ? { slug: "unknown", optedOut: false } : await deps.repo(input.cwd, left());
	const record = (fields: Pick<RouteRecord, "delivered" | "fallbacks"> & Partial<Pick<RouteRecord, "answers" | "advised" | "noted">>): RouteRecord => ({
		v: 1,
		policy: `${policy.id}@${policy.version}`,
		at: new Date(started).toISOString(),
		machine: machineName(),
		runtime: input.runtime,
		launcher: deps.env.T3CODE_CLI_PATH ? "t3" : "direct",
		session: recordText(input.sessionId, FIELD_MAX.session),
		repo: recordText(repo.slug, FIELD_MAX.repo),
		optedOut: repo.optedOut,
		...(explicit ? { explicit: recordText(commandLabel(explicit.command, deps.skillsDir), FIELD_MAX.explicit) } : {}),
		mode,
		words: input.prompt.trim().split(/\s+/).filter(Boolean).length,
		chars: input.prompt.length,
		digest: promptDigest(input.prompt),
		noted: false,
		latencyMs: deps.now() - started,
		...fields,
	});
	const rigor: Route = { level: "rigor" };

	if (mode === "off") return { record: record({ delivered: rigor, fallbacks: ["off"] }) };
	const screened = screen(explicit ? explicit.rest : input.prompt, { origin: input.origin, optedOut: repo.optedOut });
	if (screened.kind === "withhold") return { record: record({ delivered: rigor, fallbacks: [screened.reason] }) };

	const signals = [AbortSignal.timeout(Math.max(0, left()))];
	if (deps.signal) signals.push(deps.signal);
	const outcome = await deps.classify({ task: screened.text }, AbortSignal.any(signals));
	if (outcome.kind === "failed") return { record: record({ delivered: rigor, fallbacks: [outcome.reason] }) };

	const { answers } = outcome;
	const decision = decide(answers, policy);
	const fallbacks: Fallback[] = decision.fallback ? [decision.fallback] : [];
	if (explicit) return { record: record({ answers, advised: decision.advised, delivered: rigor, fallbacks: [...fallbacks, "explicit-choice"] }) };
	if (input.queued) return { record: record({ answers, advised: decision.advised, delivered: rigor, fallbacks: [...fallbacks, "queued"] }) };

	const delivery = applyModes(decision.advised, policy, mode, answers.model);
	if (delivery.fallback) fallbacks.push(delivery.fallback);
	let delivered = delivery.delivered;
	const backgroundRunSkill = join(deps.skillsDir, "background-run", "SKILL.md");
	if (delivered.level === "loop" && !existsSync(backgroundRunSkill)) {
		delivered = delivered.door ? { level: "rigor", door: delivered.door } : rigor;
		fallbacks.push("skill-missing");
	}
	const note = noteFor(delivered, backgroundRunSkill);
	return { note, record: record({ answers, advised: decision.advised, delivered, noted: note !== undefined, fallbacks }) };
}

/** Each file has one writer, so the cap only bounds the ledger's growth; the worst-case record is tested under it. */
export const RECORD_MAX_BYTES = 2048;

/** Where a session's records go: one file per runtime session, one writer each. */
export function ledgerFile(record: Pick<RouteRecord, "machine" | "runtime" | "session">, env: Record<string, string | undefined>): string {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	const session = record.session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "unknown";
	return join(state, "agentic", "task-route", record.machine, `${record.runtime}-${session}.jsonl`);
}

export function appendRecord(record: RouteRecord, env: Record<string, string | undefined>): string {
	const line = `${JSON.stringify(record)}\n`;
	const bytes = Buffer.byteLength(line);
	if (bytes > RECORD_MAX_BYTES) throw new Error(`task-route record is ${bytes} bytes, over ${RECORD_MAX_BYTES}`);
	const file = ledgerFile(record, env);
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, line);
	return file;
}
