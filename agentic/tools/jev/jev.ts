// TypeSafe's Jev classifier, used for two advisory decisions:
// - PR risk inside the ship mode: a PR whose P(one-way door) is above HOLD_ABOVE waits for the user.
//   It only adds caution; ship never lands anything because Jev said so.
// - Task class at task start: a hint when Jev says one-way door or is unsure, never otherwise.
// The questions and thresholds were calibrated together (agentic evals/jev-risk, 2026-10-07):
// changing either wording means recalibrating. Only public repositories are classified, and any
// failure takes the cautious path: hold the PR, or give no hint.

import { spawnSync } from "node:child_process";
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
		return { kind: "unavailable", detail: (error as Error).message };
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
	const statLines = input.stat.replace(/\n+$/, "").split("\n").filter(Boolean);
	const files = Math.max(0, statLines.length - 1);
	const shown = statLines.length > 40 ? [...statLines.slice(0, 39), statLines.at(-1)!] : statLines;
	const diff = input.diff.length > 6000 ? `${input.diff.slice(0, 6000)}\n[truncated]` : input.diff.replace(/\n+$/, "");
	return [`Repository: ${input.repo}`, `Subject: ${input.title}`, `Body: ${input.body.slice(0, 600)}`, `Files changed (${files}):`, ...shown, "Diff (truncated to 6000 characters):", diff].join("\n");
}

/** The key from TYPESAFE_API_KEY, or on macOS the keychain item "typesafe-jev". */
export function apiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
	if (process.platform !== "darwin") return undefined;
	const found = spawnSync("security", ["find-generic-password", "-a", env.USER ?? "", "-s", "typesafe-jev", "-w"], { encoding: "utf8", timeout: 5000 });
	return found.status === 0 ? found.stdout.trim() || undefined : undefined;
}

/** Whether owner/name is public, cached for a day; unknown counts as private. */
export function isPublic(slug: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
	const file = join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agentic", "repo-visibility.json");
	let cache: Record<string, { visibility: string; at: number }> = {};
	try {
		if (existsSync(file)) cache = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		cache = {};
	}
	const hit = cache[slug];
	if (hit && now - hit.at < 86_400_000) return hit.visibility === "PUBLIC";
	const viewed = spawnSync("gh", ["repo", "view", slug, "--json", "visibility", "-q", ".visibility"], { encoding: "utf8", timeout: 10_000 });
	if (viewed.status !== 0) return false;
	cache[slug] = { visibility: viewed.stdout.trim(), at: now };
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(cache));
	return cache[slug].visibility === "PUBLIC";
}

/** owner/name of the checkout's GitHub origin, or undefined outside one. */
export function originSlug(cwd: string): string | undefined {
	const remote = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 5000 });
	if (remote.status !== 0) return undefined;
	return /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.stdout.trim())?.[1];
}

/** The task-class hint for a prompt typed in cwd: only for tasks in public GitHub repositories. */
export async function taskHintFor(prompt: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	if (!isTask(prompt)) return undefined;
	const slug = originSlug(cwd);
	if (!slug || !isPublic(slug, env)) return undefined;
	return taskHint(await taskClass(prompt, { apiKey: apiKey(env), timeoutMs: 3000 }));
}
