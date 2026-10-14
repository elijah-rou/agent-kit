import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../vendor/orch/store.ts";
import * as verify from "./verify.ts";
import { countersignable, currentVerdict, evidenceCell, gate, githubSlug, orchStore, parseEvidenceCell, passes, readLedger, rowForHead, VERDICTS } from "./verify.ts";

describe("verdicts", () => {
	test("a verdict covers only the head it was recorded on, so a rebase voids it", () => {
		const ledger = [
			{ pr: 7, sha: "aaa", verdict: "live-ui-verified" },
			{ pr: 8, sha: "ccc", verdict: "verifier-failed" },
		];
		expect(currentVerdict(ledger, 7, "aaa")).toEqual({ state: "pass", verdict: "live-ui-verified", sha: "aaa" });
		expect(currentVerdict(ledger, 7, "bbb")).toEqual({ state: "void", verdict: "live-ui-verified", sha: "aaa" });
		expect(currentVerdict(ledger, 8, "ccc").state).toBe("fail");
		expect(currentVerdict(ledger, 9, "ddd")).toEqual({ state: "none" });
	});

	test("countersigned passes alongside the two verified kinds; nothing else does", () => {
		expect(VERDICTS.filter(passes)).toEqual(["live-ui-verified", "unit-test-verified", "countersigned"]);
		expect(passes("passed")).toBe(false);
	});

	test("the evidence cell carries the patch ID, and nothing mirrors a verdict to the forge", () => {
		expect(evidenceCell(".audit/run.log", "abc")).toBe(".audit/run.log patch:abc");
		expect(parseEvidenceCell(evidenceCell("https://x/run 1", "0f3a"))).toEqual({ evidence: "https://x/run 1", patchId: "0f3a" });
		expect(() => parseEvidenceCell("run.log")).toThrow("no patch ID");
		expect("statusFor" in verify || "STATUS_CONTEXT" in verify).toBe(false);
	});

	test("the latest row for the current head decides", () => {
		const ledger = [
			{ pr: 7, sha: "aaa", verdict: "unit-test-verified" },
			{ pr: 7, sha: "bbb", verdict: "verifier-failed" },
			{ pr: 7, sha: "aaa", verdict: "verifier-blocked" },
		];
		expect(rowForHead(ledger, 7, "aaa")?.verdict).toBe("verifier-blocked");
		expect(rowForHead(ledger, 7, "ccc")).toBeUndefined();
	});

	test("the local gate passes only a passing verdict for the head whose patch is unchanged", () => {
		const row = (sha: string, verdict: string, patch = "f1") => ({ pr: 7, sha, verdict, evidence: evidenceCell("run.log", patch) });
		const patch = (id: string) => () => id;
		expect(gate([], 7, "aaa", patch("f1"))).toEqual({ state: "none", patchChanged: false });
		expect(gate([row("old", "live-ui-verified")], 7, "aaa", patch("f1")).state).toBe("void");
		expect(gate([row("aaa", "verifier-blocked")], 7, "aaa", patch("f1")).state).toBe("fail");
		expect(gate([row("aaa", "live-ui-verified")], 7, "aaa", patch("f2"))).toEqual({ state: "void", verdict: "live-ui-verified", sha: "aaa", patchChanged: true });
		expect(gate([row("aaa", "live-ui-verified")], 7, "aaa", patch("f1"))).toEqual({ state: "pass", verdict: "live-ui-verified", sha: "aaa", patchChanged: false });
		expect(gate([row("aaa", "countersigned")], 7, "aaa", patch("f1")).state).toBe("pass");
		// No row for the head: the diff is never fetched.
		expect(gate([row("old", "live-ui-verified")], 7, "aaa", () => { throw new Error("fetched the diff"); }).state).toBe("void");
	});

	test("a countersign needs a verifier-blocked verdict for the same patch", () => {
		const row = (sha: string, verdict: string, patch = "f1") => ({ pr: 7, sha, verdict, evidence: evidenceCell("run.log", patch) });
		expect(countersignable([], 7, "aaa", "f1")).toBe(false);
		expect(countersignable([row("aaa", "verifier-blocked")], 7, "aaa", "f1")).toBe(true);
		expect(countersignable([row("aaa", "verifier-failed")], 7, "aaa", "f1")).toBe(false);
		expect(countersignable([row("aaa", "type-check-only")], 7, "aaa", "f1")).toBe(false);
		expect(countersignable([row("aaa", "verifier-blocked", "f0")], 7, "aaa", "f1")).toBe(false);
		expect(countersignable([{ ...row("aaa", "verifier-blocked"), pr: 8 }], 7, "aaa", "f1")).toBe(false);
		// Carried to a rebased head with the same patch, from either the blocked or the countersigned row.
		expect(countersignable([row("aaa", "verifier-blocked")], 7, "bbb", "f1")).toBe(true);
		expect(countersignable([row("aaa", "countersigned")], 7, "bbb", "f1")).toBe(true);
		// The head's own row decides over an older row for the same patch.
		expect(countersignable([row("aaa", "verifier-blocked"), row("bbb", "verifier-failed")], 7, "bbb", "f1")).toBe(false);
	});

	test("reads the ledger orch writes, and treats a missing ledger as no verdicts", async () => {
		const dir = join(mkdtempSync(join(tmpdir(), "verify-")), "orch");
		expect(readLedger(dir)).toEqual([]);
		const store = openStore(dir);
		try {
			await store.init();
			await store.ledger.record({ pr: 7, sha: "aaa", verdict: "unit-test-verified", evidence: "run.log patch:p", verifier: "v1" });
			await store.ledger.record({ pr: 8, sha: "bbb", verdict: "countersigned", evidence: "https://x/msg patch:q", verifier: "coordinator" });
		} finally {
			await store.close();
		}
		expect(readLedger(dir)).toEqual([
			{ pr: 7, sha: "aaa", verdict: "unit-test-verified", evidence: "run.log patch:p" },
			{ pr: 8, sha: "bbb", verdict: "countersigned", evidence: "https://x/msg patch:q" },
		]);
	});

	test("every worktree of a repository shares one untracked store in git's common directory", () => {
		expect(orchStore("/src/app/.git", {})).toBe("/src/app/.git/agentic/orch");
		expect(orchStore("/src/app/.git", { AGENTIC_ORCH_STORE: "/tmp/store" })).toBe("/tmp/store");
	});

	test("finds owner/name only in GitHub remotes", () => {
		expect(githubSlug("git@github.com:elijah-rou/agent-kit.git")).toBe("elijah-rou/agent-kit");
		expect(githubSlug("https://github.com/elijah-rou/agent-kit")).toBe("elijah-rou/agent-kit");
		expect(githubSlug("ssh://git@github.com/elijah-rou/agent-kit.git")).toBe("elijah-rou/agent-kit");
		expect(githubSlug("https://gitlab.com/elijah-rou/agent-kit.git")).toBeUndefined();
	});
});

// The CLI against a fake gh that answers only `pr view` and `pr diff`: any `gh api` call (the forge
// status the retired merge-gate read and publish wrote) fails the command.
describe("agentic verify, end to end", () => {
	const DIFF = "diff --git a/x b/x\nindex 0000001..0000002 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
	const OTHER_DIFF = DIFF.replace("+b", "+c");

	function setup(head = "a".repeat(40), state = "OPEN") {
		const root = mkdtempSync(join(tmpdir(), "verify-cli-"));
		const bin = join(root, "bin");
		const repo = join(root, "repo");
		mkdirSync(bin);
		mkdirSync(repo);
		spawnSync("git", ["init", "-q"], { cwd: repo });
		const fake = { head, state, diff: DIFF };
		const write = () => writeFileSync(join(root, "view.json"), JSON.stringify({ headRefOid: fake.head, headRefName: "agent/x", state: fake.state }));
		write();
		writeFileSync(join(root, "diff.patch"), fake.diff);
		writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n"pr view") cat "${root}/view.json";;\n"pr diff") cat "${root}/diff.patch";;\n*) echo "fake gh: unexpected gh $*" >&2; exit 1;;\nesac\n`);
		chmodSync(join(bin, "gh"), 0o755);
		const env = { PATH: `${bin}:${process.env.PATH}`, AGENTIC_ORCH_STORE: join(root, "orch"), HOME: root };
		const cli = (args: string[], agent = "verifier-1") => spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), ...args, "--repo", "o/r"], { cwd: repo, encoding: "utf8", env: { ...env, AGENTIC_AGENT_ID: agent } });
		return {
			cli,
			moveHead: (sha: string) => ((fake.head = sha), write()),
			changePatch: () => writeFileSync(join(root, "diff.patch"), OTHER_DIFF),
			ledger: () => readLedger(join(root, "orch")),
		};
	}

	test("status refuses a merge without a matching ledger verdict, and passes only one for the head and patch", () => {
		const pr = setup();
		const none = pr.cli(["status", "7"]);
		expect(none.status).toBe(1);
		expect(none.stdout).toContain(`o/r#7 (OPEN, agent/x at ${"a".repeat(12)}): ledger none`);

		expect(pr.cli(["record", "7", "--verdict", "verifier-failed", "--evidence", "run.log"]).status).toBe(0);
		const failing = pr.cli(["status", "7"]);
		expect([failing.status, failing.stdout.includes("ledger fail (verifier-failed")]).toEqual([1, true]);

		const recorded = pr.cli(["record", "7", "--verdict", "live-ui-verified", "--evidence", "run.log"]);
		expect(recorded.status).toBe(0);
		expect(recorded.stdout).toContain(`check it before merging with "agentic verify status 7"`);
		const passing = pr.cli(["status", "7"]);
		expect([passing.status, passing.stderr]).toEqual([0, ""]);
		expect(passing.stdout).toContain("ledger pass (live-ui-verified");

		pr.changePatch();
		const changed = pr.cli(["status", "7"]);
		expect([changed.status, changed.stdout.includes("ledger void, patch changed")]).toEqual([1, true]);

		pr.moveHead("b".repeat(40));
		const moved = pr.cli(["status", "7"]);
		expect([moved.status, moved.stdout.includes("ledger void (live-ui-verified on aaaaaaaaaaaa)")]).toEqual([1, true]);
	});

	test("publish is gone: it is a usage error that touches neither the ledger nor GitHub", () => {
		const pr = setup();
		const publish = pr.cli(["publish", "7"]);
		expect(publish.status).toBe(2);
		expect(publish.stderr).toContain("Usage: verify <record | status> <pr>");
		expect(pr.ledger()).toEqual([]);
	});

	test("countersigned is refused without a verifier-blocked verdict for the patch, and passes the gate once recorded", () => {
		const pr = setup();
		const refused = pr.cli(["record", "7", "--verdict", "countersigned", "--evidence", "user-message.txt"], "coordinator");
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain("no verifier-blocked verdict covers patch");
		expect(pr.ledger()).toEqual([]);

		expect(pr.cli(["record", "7", "--verdict", "verifier-failed", "--evidence", "run.log"]).status).toBe(0);
		expect(pr.cli(["record", "7", "--verdict", "countersigned", "--evidence", "user-message.txt"], "coordinator").status).toBe(1);

		expect(pr.cli(["record", "7", "--verdict", "verifier-blocked", "--evidence", "run.log"]).status).toBe(0);
		expect(pr.cli(["status", "7"]).status).toBe(1);
		const signed = pr.cli(["record", "7", "--verdict", "countersigned", "--evidence", "user-message.txt"], "coordinator");
		expect(signed.status).toBe(0);
		const status = pr.cli(["status", "7"]);
		expect([status.status, status.stdout.includes("ledger pass (countersigned")]).toEqual([0, true]);

		// A rebase that keeps the patch can carry the countersign; a changed patch cannot.
		pr.moveHead("b".repeat(40));
		expect(pr.cli(["record", "7", "--verdict", "countersigned", "--evidence", "carry.txt"], "coordinator").status).toBe(0);
		expect(pr.cli(["status", "7"]).status).toBe(0);
		pr.moveHead("c".repeat(40));
		pr.changePatch();
		expect(pr.cli(["record", "7", "--verdict", "countersigned", "--evidence", "carry.txt"], "coordinator").status).toBe(1);
	});

	test("a merged pull request reports its ledger state but takes no verdict", () => {
		const pr = setup("d".repeat(40), "MERGED");
		const status = pr.cli(["status", "9"]);
		expect([status.status, status.stdout.includes("o/r#9 (MERGED,"), status.stdout.includes("ledger none")]).toEqual([1, true, true]);
		const refused = pr.cli(["record", "9", "--verdict", "type-check-only", "--evidence", "run.log"]);
		expect([refused.status, refused.stderr.includes("verdicts are for open pull requests")]).toEqual([1, true]);
	});
});
