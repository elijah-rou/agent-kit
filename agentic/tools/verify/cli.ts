#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { repoIdentity } from "../../src/classifier.ts";
import { gitContext, orchStore, readLedger } from "../../src/facts.ts";
import { openStore } from "../../vendor/orch/store.ts";
import { currentVerdict, evidenceCell, isVerdict, STATUS_CONTEXT, statusFor, VERDICTS } from "./verify.ts";

const USAGE = `Usage: verify <record | status> <pr> [options]

Record and check verdicts for the merge ledger. Run "record" as a fresh verifier, after running
the repository's verification skill against the pull request's head: the policy gate denies it
to any session that pushed the branch.

  record <pr> --verdict <verdict> --evidence <path or https URL> [--repo owner/repo]
      Writes the ledger row bound to the head SHA and patch ID, and posts the ${STATUS_CONTEXT}
      status on the head commit (success for a passing verdict, failure otherwise).
      Verdicts: ${VERDICTS.join(", ")}.
  status <pr> [--repo owner/repo]
      Shows whether the latest verdict covers the current head. A new push or rebase voids it.

Exit status: 0 done (status: verdict passes for the head), 1 failure or no passing verdict,
2 usage error.
`;

function run(command: string, args: string[], input?: string): string {
	const result = spawnSync(command, args, { input, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

async function main(args: string[]): Promise<number> {
	const [command, prArg] = args;
	if (args.includes("--help")) return console.log(USAGE), 0;
	const pr = Number(prArg);
	if (!["record", "status"].includes(command) || !Number.isInteger(pr) || pr <= 0) return console.error(USAGE), 2;

	const ctx = gitContext(process.cwd());
	if (!ctx.repoRoot) throw new Error("run inside the repository's checkout; the ledger lives in its .agents directory");
	const origin = ctx.remoteUrl(ctx.cwd, "origin");
	const slug = option(args, "--repo") ?? (origin ? repoIdentity(origin).replace(/^github\.com\//, "") : undefined);
	if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error("cannot tell the GitHub repository; pass --repo owner/repo");
	const store = orchStore(ctx.repoRoot);
	if (!store) throw new Error("no ledger store for this checkout");

	const head = JSON.parse(run("gh", ["pr", "view", String(pr), "-R", slug, "--json", "headRefOid,headRefName,state"])) as { headRefOid: string; headRefName: string; state: string };

	if (command === "status") {
		const verdict = currentVerdict(readLedger(store), pr, head.headRefOid);
		const statuses = JSON.parse(run("gh", ["api", `repos/${slug}/commits/${head.headRefOid}/statuses`])) as { context: string; state: string; description: string }[];
		const forge = statuses.find((status) => status.context === STATUS_CONTEXT);
		console.log(`${slug}#${pr} (${head.state}, ${head.headRefName} at ${head.headRefOid.slice(0, 12)}): ledger ${verdict.state}${verdict.verdict ? ` (${verdict.verdict} on ${verdict.sha?.slice(0, 12)})` : ""}; forge ${forge ? `${forge.state}: ${forge.description}` : "no verdict status"}`);
		return verdict.state === "pass" ? 0 : 1;
	}

	const verdict = option(args, "--verdict");
	const evidence = option(args, "--evidence");
	if (!verdict || !isVerdict(verdict) || !evidence) return console.error(USAGE), 2;
	if (head.state !== "OPEN") throw new Error(`${slug}#${pr} is ${head.state}; verdicts are for open pull requests`);
	const patchId = run("git", ["patch-id", "--stable"], run("gh", ["pr", "diff", String(pr), "-R", slug])).split(" ")[0]?.trim();
	if (!patchId) throw new Error("the pull request has no diff to bind a verdict to");

	const ledger = openStore(store);
	try {
		// Idempotent: a repository's first verdict creates its store.
		await ledger.init();
		await ledger.ledger.record({ pr, sha: head.headRefOid, verdict, evidence: evidenceCell(evidence, patchId), verifier: process.env.AGENTIC_AGENT_ID ?? "agentic-verify" });
	} finally {
		await ledger.close();
	}
	const status = statusFor(verdict, patchId, evidence);
	run("gh", ["api", "-X", "POST", `repos/${slug}/statuses/${head.headRefOid}`, "-f", `state=${status.state}`, "-f", `context=${STATUS_CONTEXT}`, "-f", `description=${status.description}`, ...(status.targetUrl ? ["-f", `target_url=${status.targetUrl}`] : [])]);
	console.log(`${slug}#${pr}: recorded ${verdict} on ${head.headRefOid.slice(0, 12)} (patch ${patchId.slice(0, 12)}) and posted ${STATUS_CONTEXT}=${status.state}`);
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		console.error(`verify: ${(error as Error).message}`);
		process.exit(1);
	}
}
