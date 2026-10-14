// Everything that reaches TypeSafe passes through here: the task screen (size, credential shapes,
// opt-outs), home-path redaction, the repository-visibility check for PR diffs, the key lookup, and
// the HTTP calls. Any failure answers "unavailable", "withhold", or "not public", so every caller
// takes its cautious path.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseAnswers, QUESTIONS, type Classify, type ClassifyFailure, type Sendable } from "./route.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Lifts TypeSafe's default context limit (docs.typesafe.ai/models#context-length) on every request. */
function jevHeaders(key: string): Record<string, string> {
	return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "TypeSafe-Danger-Zone-Long-Context": "true" };
}

/** Prompts shorter than this ("yes", "continue") are follow-ups, not tasks. */
export const MIN_TASK_WORDS = 6;
/** Longer prompts are withheld: pasted logs and files hide secrets the screen does not know. */
export const MAX_TASK_CHARS = 4000;
/** A committed file at this path in a repository keeps its prompts on the machine. */
export const OPT_OUT_FILE = ".agents/jev-opt-out";

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
			headers: jevHeaders(options.apiKey),
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

const CREDENTIAL = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /AIza[0-9A-Za-z_-]{35}/, /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, /apikey_[0-9a-f]{20,}/i, /\b[rs]k_live_[A-Za-z0-9]{16,}/, /\bnpm_[A-Za-z0-9]{36}\b/, /\bglpat-[A-Za-z0-9_-]{20,}/, /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/, /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/i, /(?:password|passwd|secret|token|api[_\s-]*key)\s*[:=]\s*\S{8,}/i];

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

/** Who wrote the text: the user, a child session's parent (a brief), another extension, or the runtime itself. */
export type Origin = "user" | "child" | "extension" | "system";
export type Withheld = "child" | "extension" | "system" | "opted-out" | "not-a-task" | "unsafe-input";

// Turns the runtime starts on its own arrive in prompt hooks as if typed: Claude Code's background-task
// notifications, and T3 Code's wake-up when a delegated child finishes.
const SYSTEM_PROMPTS = [/^<task-notification>/, /^Delegated task \S+ reached a terminal state\./];

/** The origin of a prompt hook's text: "system" for a turn the runtime started, otherwise the user. */
export function promptOrigin(prompt: string): "user" | "system" {
	const text = prompt.trimStart();
	return SYSTEM_PROMPTS.some((pattern) => pattern.test(text)) ? "system" : "user";
}
export type Screened = { kind: "send"; text: Sendable } | { kind: "withhold"; reason: Withheld };

/** Whether a prompt may be sent, and the redacted text if so. The only place a Sendable is made. */
export function screen(prompt: string, where: { origin: Origin; optedOut: boolean }): Screened {
	if (where.origin !== "user") return { kind: "withhold", reason: where.origin };
	if (where.optedOut) return { kind: "withhold", reason: "opted-out" };
	if (!isTask(prompt)) return { kind: "withhold", reason: "not-a-task" };
	if (prompt.length > MAX_TASK_CHARS) return { kind: "withhold", reason: "unsafe-input" };
	const text = sendable(prompt.trim());
	if (text === undefined) return { kind: "withhold", reason: "unsafe-input" };
	return { kind: "send", text: text as Sendable };
}

export type Repo = { slug: string; optedOut: boolean };

/** The nearest directory at or above dir that holds a `.git` entry, found without spawning git. */
export function checkoutRoot(dir: string): string | undefined {
	let current = resolve(dir);
	for (let depth = 0; depth < 256; depth++) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	throw new Error(`checkoutRoot: no filesystem root above ${dir}`);
}

/**
 * The git directory every worktree of root's clone shares, found without spawning git: a worktree's
 * `.git` file names its own git directory, whose `commondir` file names the shared one.
 */
export function commonDir(root: string): string {
	const dotGit = join(root, ".git");
	let dir = dotGit;
	if (!statSync(dotGit).isDirectory()) {
		const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
		if (gitdir !== undefined) {
			const own = resolve(root, gitdir);
			const common = join(own, "commondir");
			dir = existsSync(common) ? resolve(own, readFileSync(common, "utf8").trim()) : own;
		}
	}
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

/**
 * The repository a prompt was typed in: owner/name for a GitHub origin, "none" outside a checkout,
 * and for any other checkout "other:" and 16 hex digits of its common git directory, so each clone,
 * worktrees included, is its own bucket without its path reaching a record.
 */
export async function repoOf(cwd: string, timeoutMs: number): Promise<Repo> {
	const root = checkoutRoot(cwd);
	if (root === undefined) return { slug: "none", optedOut: false };
	const optedOut = existsSync(join(root, OPT_OUT_FILE));
	const slug = (await originSlug(root, timeoutMs)) ?? `other:${createHash("sha256").update(commonDir(root)).digest("hex").slice(0, 16)}`;
	return { slug, optedOut };
}

function failure(error: unknown, signal: AbortSignal): ClassifyFailure {
	const reason: unknown = signal.aborted ? signal.reason : error;
	if (reason instanceof Error && reason.name === "TimeoutError") return "timeout";
	return signal.aborted ? "cancelled" : "error";
}

/** Resolves with the work's result, or with undefined as soon as signal aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const abort = () => resolve(undefined);
		signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => (signal.removeEventListener("abort", abort), resolve(value)),
			() => (signal.removeEventListener("abort", abort), resolve(undefined)),
		);
	});
}

/** Jev over HTTP, with the key from key(), which the deadline also bounds. Both questions go in one request. */
export function httpClassifier(key: () => Promise<string | undefined>, fetchImpl: FetchLike = fetch): Classify {
	return async (state, signal) => {
		const token = await untilAborted(key(), signal);
		if (signal.aborted) return { kind: "failed", reason: failure(signal.reason, signal) };
		if (!token) return { kind: "failed", reason: "classifier-unavailable" };
		try {
			const response = await fetchImpl(JEV_ENDPOINT, {
				method: "POST",
				headers: jevHeaders(token),
				body: JSON.stringify({ model: JEV_MODEL, state, questions: QUESTIONS }),
				signal,
			});
			if (!response.ok) return { kind: "failed", reason: "error" };
			const body: unknown = await response.json();
			const answers = isRecord(body) ? parseAnswers(body.model, body.answers) : undefined;
			return answers ? { kind: "answered", answers } : { kind: "failed", reason: "malformed" };
		} catch (error) {
			return { kind: "failed", reason: failure(error, signal) };
		}
	};
}
