#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { openStore } from "../../vendor/orch/store.ts";
import { countersignEvidence, evidenceCell, gate, githubSlug, isVerdict, orchStore, readLedger, VERDICTS } from "./verify.ts";

const USAGE = `Usage: verify <record | status> <pr> [options]

Record and check verdicts in the merge ledger, kept in git's common directory. The ledger is the
merge gate: every merging mode runs status right before each merge, and merges only on exit 0.

  record <pr> --verdict <verdict> --evidence <path or https URL> [--patch <patch ID>] [--repo owner/repo]
      Run only as a fresh verifier that did not write the change, after running the repository's
      verification skill against the pull request's head. Writes the ledger row bound to the
      head SHA and patch ID. Local only: it publishes nothing.
      Verdicts: ${VERDICTS.join(", ")}.
      countersigned is the coordinator's, not the verifier's: it records the user's approval in
      words of a pull request a fresh verifier marked verifier-blocked, and is refused unless a
      verifier-blocked verdict covers the same patch and --patch names that patch in full: the
      patch ID shown to the user with the head they approved. A changed patch needs new words from
      the user. Its evidence cites the user's message; record appends the blocked verdict's
      verifier ID and evidence to it, since the countersign replaces that row.
  status <pr> [--repo owner/repo]
      Shows whether the verdict for the current head passes and still covers its patch. A new
      push, rebase, or changed patch voids it.

Exit status: 0 done (status: a passing verdict covers the head and its patch), 1 failure or no
passing verdict, 2 usage error.
`;

function run(command: string, args: string[], input?: string): string {
	const result = spawnSync(command, args, { input, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

function git(args: string[]): string | undefined {
	const result = spawnSync("git", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
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

	const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!commonDir) throw new Error("run inside the repository's checkout; the ledger lives in its git directory");
	const origin = git(["remote", "get-url", "origin"]);
	const slug = option(args, "--repo") ?? (origin ? githubSlug(origin) : undefined);
	if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error("cannot tell the GitHub repository; pass --repo owner/repo");
	const store = orchStore(commonDir);

	const head = JSON.parse(run("gh", ["pr", "view", String(pr), "-R", slug, "--json", "headRefOid,headRefName,state"])) as { headRefOid: string; headRefName: string; state: string };

	const patchId = (): string => {
		const id = run("git", ["patch-id", "--stable"], run("gh", ["pr", "diff", String(pr), "-R", slug])).split(" ")[0]?.trim();
		if (!id) throw new Error("the pull request has no diff to bind a verdict to");
		return id;
	};

	if (command === "status") {
		const result = gate(readLedger(store), pr, head.headRefOid, patchId);
		const state = result.patchChanged ? "void, patch changed" : result.state;
		console.log(`${slug}#${pr} (${head.state}, ${head.headRefName} at ${head.headRefOid.slice(0, 12)}): ledger ${state}${result.verdict ? ` (${result.verdict} on ${result.sha?.slice(0, 12)})` : ""}`);
		return result.state === "pass" ? 0 : 1;
	}

	if (head.state !== "OPEN") throw new Error(`${slug}#${pr} is ${head.state}; verdicts are for open pull requests`);

	const verdict = option(args, "--verdict");
	const evidence = option(args, "--evidence");
	if (!verdict || !isVerdict(verdict) || !evidence || (verdict !== "countersigned" && args.includes("--patch"))) return console.error(USAGE), 2;
	const patch = patchId();
	let recorded = evidence;
	if (verdict === "countersigned") {
		const signed = countersignEvidence(readLedger(store), pr, head.headRefOid, patch, option(args, "--patch"), evidence);
		if (!signed.ok) throw new Error(`${slug}#${pr}: ${signed.reason}`);
		recorded = signed.evidence;
	}

	const ledger = openStore(store);
	try {
		// Idempotent: a repository's first verdict creates its store.
		await ledger.init();
		await ledger.ledger.record({ pr, sha: head.headRefOid, verdict, evidence: evidenceCell(recorded, patch), verifier: process.env.AGENTIC_AGENT_ID ?? "agentic-verify" });
	} finally {
		await ledger.close();
	}
	console.log(`${slug}#${pr}: recorded ${verdict} on ${head.headRefOid.slice(0, 12)} (patch ${patch.slice(0, 12)}); check it before merging with "agentic verify status ${pr}"`);
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
