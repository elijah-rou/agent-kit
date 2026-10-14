#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { apiKey, httpClassifier, isPublic, originSlug, OPT_OUT_FILE, promptOrigin, repoOf, sendable } from "./egress.ts";
import { HOLD_ABOVE, prDecision, prRisk, prState } from "./pr-risk.ts";
import { appendRecord, routeTask, type RouteDeps, type RouteRecord, type Runtime } from "./route-task.ts";
import { POLICY } from "./route.ts";

const USAGE = `Usage: jev <pr-risk | task-class> ...

Advisory Jev calls, calibrated in the agentic evals. The key comes from TYPESAFE_API_KEY or, on
macOS, the keychain item "typesafe-jev".

  pr-risk <pr> [--repo owner/repo]
      For the ship mode, before landing a PR: exit 0 when P(one-way door) <= ${HOLD_ABOVE}; any other
      exit means the PR waits for the user (a higher score, Jev unavailable or without a key, a
      repository that is not public, or a diff with credential-shaped text, which is never sent).
  task-class --claude-hook | --codex-hook
      Routes the prompt in the runtime's UserPromptSubmit event on stdin (policy task-route, see
      route.ts), appends one record to $XDG_STATE_HOME/agentic/task-route/, and answers with
      additionalContext when a note applies. It never blocks the prompt.
  task-class <task text>
      Prints the route for a task typed in the current directory, without recording it.

A repository that commits ${OPT_OUT_FILE} never sends its prompts. AGENTIC_ROUTE=shadow keeps every
note back for a session, and AGENTIC_ROUTE=off also stops every request.
`;

const SKILLS_DIR = join(import.meta.dir, "..", "..", "..", "skills");

function routeDeps(env: Record<string, string | undefined>): RouteDeps {
	return { policy: POLICY, classify: httpClassifier(() => apiKey(env, 1000)), repo: repoOf, env, now: Date.now, skillsDir: SKILLS_DIR };
}

/**
 * The hook's whole answer for a note: added context and nothing else. It never carries a decision,
 * `continue`, or a stop reason, so a note is advice the agent reads and never blocks the prompt.
 */
export function hookAnswer(note: string | undefined): string | undefined {
	return note === undefined ? undefined : JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: note } });
}

/** A UserPromptSubmit hook: Claude Code and Codex send the same prompt, cwd, and session_id fields. */
export async function promptHook(runtime: Runtime, eventText: string, deps: RouteDeps): Promise<{ answer?: string; record: RouteRecord }> {
	const event: unknown = JSON.parse(eventText);
	const field = (name: string) => (typeof event === "object" && event !== null && typeof (event as Record<string, unknown>)[name] === "string" ? ((event as Record<string, unknown>)[name] as string) : undefined);
	const prompt = field("prompt") ?? "";
	const input = { prompt, cwd: field("cwd") ?? process.cwd(), runtime, sessionId: field("session_id") ?? "unknown", origin: promptOrigin(prompt), queued: false };
	const { note, record } = await routeTask(input, deps);
	const answer = hookAnswer(note);
	return answer === undefined ? { record } : { answer, record };
}

function run(command: string, args: string[], input?: string): string {
	const result = spawnSync(command, args, { input, encoding: "utf8", timeout: 30_000, maxBuffer: 50_000_000 });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

async function main(args: string[]): Promise<number> {
	const [command, ...rest] = args;
	if (command === "--help" || command === "-h") return console.log(USAGE), 0;

	if (command === "task-class") {
		const hook = rest[0] === "--claude-hook" ? "claude" : rest[0] === "--codex-hook" ? "codex" : undefined;
		if (hook) {
			try {
				const { answer, record } = await promptHook(hook, await Bun.stdin.text(), routeDeps(process.env));
				if (answer) console.log(answer);
				appendRecord(record, process.env);
			} catch {
				// Routing is optional; a failure must never block the prompt. A missing record shows in route-report.
			}
			return 0;
		}
		const text = rest.join(" ").trim();
		if (!text) return console.error(USAGE), 2;
		const { note, record } = await routeTask({ prompt: text, cwd: process.cwd(), runtime: "cli", sessionId: "manual", origin: "user" as const, queued: false }, routeDeps(process.env));
		console.log(JSON.stringify({ repo: record.repo, advised: record.advised, delivered: record.delivered, fallbacks: record.fallbacks, model: record.answers?.model }));
		console.log(note ?? "no note");
		return 0;
	}

	if (command !== "pr-risk") return console.error(USAGE), 2;
	const pr = Number(rest[0]);
	if (!Number.isInteger(pr) || pr <= 0) return console.error(USAGE), 2;
	const repoIndex = rest.indexOf("--repo");
	const slug = repoIndex === -1 ? await originSlug(process.cwd()) : rest[repoIndex + 1];
	if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error("cannot tell the GitHub repository; pass --repo owner/repo");
	if (!(await isPublic(slug, { fresh: true }))) {
		console.log(`${slug}#${pr}: hold, not a public repository, so Jev does not see its diff`);
		return 1;
	}
	const view = JSON.parse(run("gh", ["pr", "view", String(pr), "-R", slug, "--json", "title,body"])) as { title: string; body: string };
	const diff = run("gh", ["pr", "diff", String(pr), "-R", slug]);
	const stat = run("git", ["apply", "--stat"], diff);
	const state = sendable(prState({ repo: slug, title: view.title, body: view.body ?? "", stat, diff }));
	if (!state) {
		console.log(`${slug}#${pr}: hold, the PR contains credential-shaped text, so it is not sent to Jev`);
		return 1;
	}
	const decision = prDecision(await prRisk(state, { apiKey: await apiKey(), timeoutMs: 10_000 }));
	console.log(`${slug}#${pr}: ${decision.hold ? "hold" : "clear"}, ${decision.reason}`);
	return decision.hold ? 1 : 0;
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		console.error(`jev: ${(error as Error).message}`);
		process.exit(1);
	}
}
