// TypeSafe's Jev classifier, used for two advisory decisions:
// - PR risk inside the ship mode: a PR whose P(one-way door) is above HOLD_ABOVE waits for the user.
//   It only adds caution; ship never lands anything because Jev said so.
// - Task class at task start: a hint when Jev says one-way door or is unsure, never otherwise.
// The questions and thresholds were calibrated together (agentic evals/jev-risk, 2026-10-07):
// changing either wording means recalibrating. Only public repositories are classified, and any
// failure takes the cautious path: hold the PR, or give no hint.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** A PR scoring above this waits for the user: 73 of 82 one-way doors held, 32 of 99 safe PRs held. */
export const HOLD_ABOVE = 0.3;
/** Below this confidence, a task gets the one-way-door hint whatever Jev chose: 2 of 30 one-way doors missed, 16 of 120 others hinted. */
export const HINT_BELOW_CONFIDENCE = 0.8;
/** Prompts shorter than this ("yes", "continue") are follow-ups, not tasks. */
export const MIN_TASK_WORDS = 6;

export const PR_RISK_INSTRUCTIONS =
	"The state is a change about to be merged into a software repository's default branch. " +
	"Answer yes if landing it is a one-way door: merging could not be fully undone by reverting the commit, " +
	"or it commits the project to something others depend on. That includes a public contract (an API, CLI flags or output, " +
	"a file or wire format, a config schema others consume), persisted data (schemas, migrations, stored-data formats, " +
	"deleting or rewriting stored data), a security boundary (authentication, authorization, permissions, credentials or secrets, " +
	"sandboxing, CI permissions, branch protection, new dependency sources or install scripts), a release or deploy, " +
	"or hard-to-reverse architecture, core data structures, or the ownership or concurrency model. " +
	"Answer no for internal refactors, documentation, tests, checksum-verified version bumps, styling, " +
	"and other changes a plain revert fully undoes.";

export const TASK_INSTRUCTIONS = "The state is a software task given to a coding agent. Classify how the agent should approach it.";
export const TASK_CRITERIA = {
	reversible: "An ordinary change that is easy to undo; the agent can just build it and show the result.",
	experiment:
		"There are candidate approaches, or the value is unclear, and building, prototyping, or measuring would settle it before committing.",
	"one-way-door":
		"Hard to reverse: changes a public contract or API, persisted data or file formats, a security boundary, " +
		"hard-to-reverse architecture, or core data structures and the ownership or concurrency model.",
} as const;
export type TaskClass = keyof typeof TASK_CRITERIA;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type Unavailable = { kind: "unavailable"; detail: string };
export type Noul = { kind: "ok"; probability: number } | Unavailable;
export type Choice = { kind: "ok"; choice: TaskClass; confidence: number } | Unavailable;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** One question per call; no retries, because every caller has a cautious fallback. */
export async function askJev(question: Record<string, unknown>, state: string, options: { apiKey: string | undefined; timeoutMs: number; fetch?: FetchLike }): Promise<Record<string, unknown> | Unavailable> {
	if (!options.apiKey) return { kind: "unavailable", detail: "no TypeSafe key" };
	try {
		const response = await (options.fetch ?? fetch)(JEV_ENDPOINT, {
			method: "POST",
			headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: JEV_MODEL, state, questions: { q: question } }),
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		if (!response.ok) return { kind: "unavailable", detail: `HTTP ${response.status}` };
		const body: unknown = await response.json();
		if (!isRecord(body) || !isRecord(body.answers) || !isRecord(body.answers.q)) return { kind: "unavailable", detail: "no answer in the response" };
		return body.answers.q;
	} catch (error) {
		// Only the error's name: a message could quote the request, including its header.
		return { kind: "unavailable", detail: error instanceof Error ? error.name : "request failed" };
	}
}

export async function prRisk(state: string, options: Parameters<typeof askJev>[2]): Promise<Noul> {
	const answer = await askJev({ type: "noul", instructions: PR_RISK_INSTRUCTIONS }, state, options);
	if (answer.kind === "unavailable") return answer as Unavailable;
	return answer.type === "noul" && isProbability(answer.noul) ? { kind: "ok", probability: answer.noul } : { kind: "unavailable", detail: "malformed noul answer" };
}

export async function taskClass(task: string, options: Parameters<typeof askJev>[2]): Promise<Choice> {
	const answer = await askJev({ type: "choice", instructions: TASK_INSTRUCTIONS, criteria: TASK_CRITERIA }, task, options);
	if (answer.kind === "unavailable") return answer as Unavailable;
	const valid = answer.type === "choice" && typeof answer.choice === "string" && answer.choice in TASK_CRITERIA && isProbability(answer.confidence);
	return valid ? { kind: "ok", choice: answer.choice as TaskClass, confidence: answer.confidence as number } : { kind: "unavailable", detail: "malformed choice answer" };
}

/** Whether the ship mode may land the PR without the user: only on a confident, low score. */
export function prDecision(result: Noul): { hold: boolean; reason: string } {
	if (result.kind === "unavailable") return { hold: true, reason: `Jev unavailable (${result.detail})` };
	return result.probability > HOLD_ABOVE
		? { hold: true, reason: `P(one-way door) ${result.probability.toFixed(2)} > ${HOLD_ABOVE}` }
		: { hold: false, reason: `P(one-way door) ${result.probability.toFixed(2)} <= ${HOLD_ABOVE}` };
}

/** The hint for a task, or undefined when there is nothing to say (including when Jev failed). */
export function taskHint(result: Choice): string | undefined {
	if (result.kind === "unavailable") return undefined;
	if (result.choice !== "one-way-door" && result.confidence >= HINT_BELOW_CONFIDENCE) return undefined;
	const why = result.choice === "one-way-door" ? `classifies it as a one-way door (confidence ${result.confidence.toFixed(2)})` : `is unsure (${result.choice}, confidence ${result.confidence.toFixed(2)})`;
	return `Task-class hint, advisory: Jev ${why}. Before building, check the task against the one-way-door list in your instructions; if it is one, compare design shapes with design-checkpoint first.`;
}

export function isTask(prompt: string): boolean {
	return prompt.trim().split(/\s+/).filter(Boolean).length >= MIN_TASK_WORDS;
}

/** The classifier state for a PR, in the layout the thresholds were calibrated on. */
export function prState(input: { repo: string; title: string; body: string; stat: string; diff: string }): string {
	const body = input.body.replace(/\r\n/g, "\n").trim();
	const statLines = input.stat.replace(/\n+$/, "").split("\n").filter(Boolean);
	const files = Math.max(0, statLines.length - 1);
	const shown = statLines.length > 40 ? [...statLines.slice(0, 39), statLines.at(-1)!] : statLines;
	const diff = input.diff.length > 6000 ? `${input.diff.slice(0, 6000)}\n[truncated]` : input.diff.replace(/\n+$/, "");
	return [`Repository: ${input.repo}`, `Subject: ${input.title}`, `Body: ${body.slice(0, 600)}`, `Files changed (${files}):`, ...shown, "Diff (truncated to 6000 characters):", diff].join("\n");
}

const CREDENTIAL = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/];

/**
 * The text as it may be sent to TypeSafe: home directories become "~", and anything shaped like a
 * credential means it is not sent at all (undefined).
 */
export function sendable(text: string): string | undefined {
	if (CREDENTIAL.some((pattern) => pattern.test(text))) return undefined;
	return text.replace(/\/(?:Users|home)\/[^/\s]+/g, "~");
}

/** Runs a command with a timeout; undefined on failure, so callers take their cautious path. */
function output(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
	if (timeoutMs <= 0) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile(command, args, { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
	});
}

/** The key from TYPESAFE_API_KEY, or on macOS the keychain item "typesafe-jev". */
export async function apiKey(env: NodeJS.ProcessEnv = process.env, timeoutMs = 2000): Promise<string | undefined> {
	if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
	if (process.platform !== "darwin") return undefined;
	return output("security", ["find-generic-password", "-a", env.USER ?? "", "-s", "typesafe-jev", "-w"], timeoutMs);
}

const DAY_MS = 86_400_000;
const FAILURE_MS = 600_000;

/**
 * Whether owner/name is public; unknown counts as private. Answers are cached for a day and a
 * failed lookup for ten minutes, unless fresh is set (pr-risk, which runs rarely and sends a diff).
 */
export async function isPublic(slug: string, options: { env?: NodeJS.ProcessEnv; fresh?: boolean; timeoutMs?: number; now?: number } = {}): Promise<boolean> {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now();
	const file = join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agentic", "repo-visibility.json");
	let cache: Record<string, { visibility: string; at: number }> = {};
	try {
		if (existsSync(file)) cache = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		cache = {};
	}
	const hit = cache[slug];
	const age = hit ? now - hit.at : Infinity;
	if (!options.fresh && hit && age >= 0 && age < (hit.visibility === "UNKNOWN" ? FAILURE_MS : DAY_MS)) return hit.visibility === "PUBLIC";
	const visibility = (await output("gh", ["repo", "view", slug, "--json", "visibility", "-q", ".visibility"], options.timeoutMs ?? 10_000)) ?? "UNKNOWN";
	cache[slug] = { visibility, at: now };
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(cache));
	} catch {
		// The cache only saves time.
	}
	return visibility === "PUBLIC";
}

/** owner/name of the checkout's GitHub origin, or undefined outside one. */
export async function originSlug(cwd: string, timeoutMs = 2000): Promise<string | undefined> {
	const remote = await output("git", ["-C", cwd, "remote", "get-url", "origin"], timeoutMs);
	return remote ? /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1] : undefined;
}

/** The whole hint path stays under this, so a prompt never waits longer for a hint. */
export const HINT_DEADLINE_MS = 3000;

/** The task-class hint for a prompt typed in cwd: only for tasks in public GitHub repositories. */
export async function taskHintFor(prompt: string, cwd: string, env: NodeJS.ProcessEnv = process.env, fetch?: FetchLike): Promise<string | undefined> {
	const text = sendable(prompt);
	if (!text || !isTask(prompt)) return undefined;
	const deadline = Date.now() + HINT_DEADLINE_MS;
	const left = () => deadline - Date.now();
	const slug = await originSlug(cwd, left());
	if (!slug || !(await isPublic(slug, { env, timeoutMs: left() }))) return undefined;
	const key = await apiKey(env, left());
	if (left() <= 0) return undefined;
	return taskHint(await taskClass(text, { apiKey: key, timeoutMs: left(), fetch }));
}
