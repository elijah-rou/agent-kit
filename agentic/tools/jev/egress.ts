// Everything that reaches TypeSafe passes through here: the credential screen, home-path redaction,
// the repository-visibility check, the key lookup, and the one HTTP call. Any failure answers
// "unavailable" or "not public", so every caller takes its cautious path.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Prompts shorter than this ("yes", "continue") are follow-ups, not tasks. */
export const MIN_TASK_WORDS = 6;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type Unavailable = { kind: "unavailable"; detail: string };

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

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

export function isTask(prompt: string): boolean {
	return prompt.trim().split(/\s+/).filter(Boolean).length >= MIN_TASK_WORDS;
}

const CREDENTIAL = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /AIza[0-9A-Za-z_-]{35}/, /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, /apikey_[0-9a-f]{20,}/i, /(?:password|passwd|secret|token|api[_\s-]*key)\s*[:=]\s*\S{8,}/i];

/**
 * The text as it may be sent to TypeSafe: home directories become "~", and text containing a common
 * credential format (tokens, keys, JWTs, password assignments) is not sent at all (undefined).
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
