#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { apiKey, HOLD_ABOVE, isPublic, originSlug, prDecision, prRisk, prState, sendable, taskHintFor } from "./jev.ts";

const USAGE = `Usage: jev <pr-risk | task-class> ...

Advisory Jev calls, calibrated in the agentic evals (only public repositories are classified).

  pr-risk <pr> [--repo owner/repo]
      For the ship mode, before landing a PR: exit 0 when P(one-way door) <= ${HOLD_ABOVE}; any other
      exit means the PR waits for the user (a higher score, Jev unavailable or without a key, a
      repository that is not public, or a diff with credential-shaped text, which is never sent).
      The key comes from TYPESAFE_API_KEY or, on macOS, the keychain item "typesafe-jev".
  task-class [--claude-hook] [task text]
      Prints a one-way-door hint for the task, or nothing. With --claude-hook, reads Claude Code's
      UserPromptSubmit event from stdin and answers with additionalContext; it never blocks.
`;

function run(command: string, args: string[], input?: string): string {
	const result = spawnSync(command, args, { input, encoding: "utf8", timeout: 30_000, maxBuffer: 50_000_000 });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

async function main(args: string[]): Promise<number> {
	const [command, ...rest] = args;
	if (command === "--help" || command === "-h") return console.log(USAGE), 0;

	if (command === "task-class") {
		if (rest.includes("--claude-hook")) {
			try {
				const event = JSON.parse(await Bun.stdin.text()) as { prompt?: string; cwd?: string };
				const hint = await taskHintFor(event.prompt ?? "", event.cwd ?? process.cwd());
				if (hint) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: hint } }));
			} catch {
				// A hint is optional; a failure must never block the prompt.
			}
			return 0;
		}
		const text = rest.join(" ").trim();
		if (!text) return console.error(USAGE), 2;
		console.log((await taskHintFor(text, process.cwd())) ?? "no hint");
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
