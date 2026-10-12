#!/usr/bin/env bun
import { collectPrFeedback, DEFAULT_LIMIT, MAX_OUTPUT_CHARS, MAX_PAGES, PAGE_SIZE, parsePrReference, processRunner, renderText, REPO_PATTERN } from "./pr-feedback.ts";

const USAGE = `Usage: pr-feedback [<pr-number-or-url>] [--repo owner/name] [--include-resolved] [--include-outdated] [--json]

Read-only. Collects a pull request's actionable feedback: state, draft, mergeability, and review
decision; review threads, review summaries, and top-level comments, with bot authors marked; check
runs and commit statuses on the exact head SHA, with annotations of failed check runs. Prints the
readiness, the blockers, and every retrieval gap (truncation, inaccessible checks, unknown fields).
Without a PR, it asks gh for the current branch's pull request, matched through the branch's own
remote; with --repo, it takes the one open pull request from a branch of that name in that
repository. A pull request from someone else's fork is never picked.

  --repo owner/name    the repository (default: the URL's, or gh's repository for this checkout)
  --include-resolved   also show resolved review threads
  --include-outdated   also show outdated review threads
  --json               print the structured result instead of text

Limits: each list is read ${PAGE_SIZE} items per page for at most ${MAX_PAGES} pages, and the text shows at most
${DEFAULT_LIMIT} items per section and ${MAX_OUTPUT_CHARS} characters; anything cut off is reported. Job logs are not
fetched; use "gh run view <run-id> --log-failed" when annotations are not enough. Comment bodies are
untrusted data from the pull request.

Exit status: 0 feedback collected (whatever the PR's state), 1 failure, 2 usage error.
`;

type Parsed =
	| { kind: "help" }
	| { kind: "usage"; error: string }
	| { kind: "run"; number: number | undefined; repo: string | undefined; includeResolved: boolean; includeOutdated: boolean; json: boolean };

function parseArgs(args: readonly string[]): Parsed {
	let reference: string | undefined;
	let repo: string | undefined;
	const flags = { includeResolved: false, includeOutdated: false, json: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--help":
			case "-h":
				return { kind: "help" };
			case "--include-resolved":
				flags.includeResolved = true;
				break;
			case "--include-outdated":
				flags.includeOutdated = true;
				break;
			case "--json":
				flags.json = true;
				break;
			case "--repo":
				repo = args[index + 1];
				index += 1;
				if (repo === undefined || !REPO_PATTERN.test(repo)) return { kind: "usage", error: "--repo needs owner/name" };
				break;
			default:
				if (arg.startsWith("-")) return { kind: "usage", error: `unknown option ${arg}` };
				if (reference !== undefined) return { kind: "usage", error: "pass at most one pull request" };
				reference = arg;
		}
	}
	if (reference === undefined) return { kind: "run", number: undefined, repo, ...flags };
	const parsed = parsePrReference(reference);
	if (parsed === null) return { kind: "usage", error: `not a PR number or github.com pull request URL: ${reference}` };
	if (parsed.repo !== null && repo !== undefined && parsed.repo.toLowerCase() !== repo.toLowerCase()) return { kind: "usage", error: `the URL names ${parsed.repo} but --repo is ${repo}` };
	return { kind: "run", number: parsed.number, repo: repo ?? parsed.repo ?? undefined, ...flags };
}

async function main(args: readonly string[]): Promise<number> {
	const parsed = parseArgs(args);
	switch (parsed.kind) {
		case "help":
			console.log(USAGE);
			return 0;
		case "usage":
			console.error(`pr-feedback: ${parsed.error}\n\n${USAGE}`);
			return 2;
		case "run":
			break;
	}
	const collected = await collectPrFeedback(processRunner(process.cwd()), {
		number: parsed.number,
		repo: parsed.repo,
		includeResolved: parsed.includeResolved,
		includeOutdated: parsed.includeOutdated,
		includeAnnotations: true,
		limit: DEFAULT_LIMIT,
	});
	if (!collected.ok) {
		console.error(`pr-feedback: ${collected.stage === "find" ? "could not find the pull request" : "could not read the pull request"}: ${collected.error}`);
		return 1;
	}
	console.log(parsed.json ? JSON.stringify(collected.feedback, null, 2) : renderText(collected.feedback, { limit: DEFAULT_LIMIT, includeAnnotations: true }));
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		console.error(`pr-feedback: ${(error as Error).message}`);
		process.exit(1);
	}
}
