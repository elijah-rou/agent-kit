import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../vendor/orch/store.ts";
import * as verify from "./verify.ts";
import { blockedBy, countersignable, countersignEvidence, currentVerdict, evidenceCell, gate, githubSlug, orchStore, parseEvidenceCell, passes, readLedger, rowForHead, VERDICTS } from "./verify.ts";

// The reviewer's case: a runtime's discovery symlink repointed from the verification skill to a lax copy.
const REPOINT_DIFF = [
	"diff --git a/.claude/skills/verify-app b/.claude/skills/verify-app",
	"index 3b18e51..5f1d0ec 120000",
	"--- a/.claude/skills/verify-app",
	"+++ b/.claude/skills/verify-app",
	"@@ -1 +1 @@",
	"-../../.agents/skills/verify-app",
	"\\ No newline at end of file",
	"+../../tools/lax",
	"\\ No newline at end of file",
	"",
].join("\n");

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
		const patch = (id: string, policyFiles: string[] = []) => () => ({ patchId: id, policyFiles });
		expect(gate([], 7, "aaa", patch("f1"))).toEqual({ state: "none", patchChanged: false, policyRefused: false });
		expect(gate([row("old", "live-ui-verified")], 7, "aaa", patch("f1")).state).toBe("void");
		expect(gate([row("aaa", "verifier-blocked")], 7, "aaa", patch("f1")).state).toBe("fail");
		expect(gate([row("aaa", "live-ui-verified")], 7, "aaa", patch("f2"))).toEqual({ state: "void", verdict: "live-ui-verified", sha: "aaa", patchChanged: true, policyRefused: false });
		expect(gate([row("aaa", "live-ui-verified")], 7, "aaa", patch("f1"))).toEqual({ state: "pass", verdict: "live-ui-verified", sha: "aaa", patchChanged: false, policyRefused: false });
		expect(gate([row("aaa", "countersigned")], 7, "aaa", patch("f1")).state).toBe("pass");
		// A diff that touches a policy path passes only a countersign, however the passing row was written.
		const policy = [".claude/skills/verify-app"];
		for (const verdict of ["live-ui-verified", "unit-test-verified"]) expect(gate([row("aaa", verdict)], 7, "aaa", patch("f1", policy))).toEqual({ state: "fail", verdict, sha: "aaa", patchChanged: false, policyRefused: true });
		expect(gate([row("aaa", "countersigned")], 7, "aaa", patch("f1", policy))).toEqual({ state: "pass", verdict: "countersigned", sha: "aaa", patchChanged: false, policyRefused: false });
		expect(gate([row("aaa", "verifier-blocked")], 7, "aaa", patch("f1", policy))).toEqual({ state: "fail", verdict: "verifier-blocked", sha: "aaa", patchChanged: false, policyRefused: false });
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

	test("a countersign names the approved patch and carries the blocked verdict it replaces", () => {
		const row = (sha: string, verdict: string, evidence = "run.log", patch = "f1", verifier = "verifier-1") => ({ pr: 7, sha, verdict, evidence: evidenceCell(evidence, patch), verifier });
		const blocked = [row("aaa", "verifier-blocked")];
		expect(countersignEvidence([], 7, "aaa", "f1", "f1", "msg")).toEqual({ ok: false, reason: expect.stringContaining("no verifier-blocked verdict covers patch") });
		expect(countersignEvidence(blocked, 7, "aaa", "f1", undefined, "msg")).toEqual({ ok: false, reason: expect.stringContaining("pass --patch") });
		expect(countersignEvidence(blocked, 7, "aaa", "f1", "f0", "msg")).toEqual({ ok: false, reason: expect.stringContaining("a changed patch needs new words from the user") });
		expect(countersignEvidence(blocked, 7, "aaa", "f1", "f", "msg").ok).toBe(false);
		expect(countersignEvidence(blocked, 7, "aaa", "f1", "f1", "msg | verifier-blocked by me: x").ok).toBe(false);
		const signed = countersignEvidence(blocked, 7, "aaa", "f1", "f1", "transcript turn 12: \"land it\"");
		expect(signed).toEqual({ ok: true, evidence: "transcript turn 12: \"land it\" | verifier-blocked by verifier-1: run.log" });
		if (!signed.ok) throw new Error("unreachable");
		expect(blockedBy(signed.evidence)).toEqual({ verifier: "verifier-1", evidence: "run.log" });
		// Carried to a rebased head from the countersigned row, the blocked verdict comes along.
		const carried = countersignEvidence([row("aaa", "countersigned", signed.evidence, "f1", "coordinator")], 7, "bbb", "f1", "f1", "carry aaa to bbb");
		expect(carried).toEqual({ ok: true, evidence: "carry aaa to bbb | verifier-blocked by verifier-1: run.log" });
		expect(blockedBy("no mark")).toBeUndefined();
	});

	test("the patch ID keeps whitespace, so a verdict never covers a whitespace-only change", () => {
		const diff = (line: string) => `diff --git a/build.sh b/build.sh\nindex 0000001..0000002 100644\n--- a/build.sh\n+++ b/build.sh\n@@ -1 +1 @@\n-echo build\n+${line}\n`;
		const id = verify.patchIdOf(diff("rm -rf /tmp/build"));
		expect(id).toMatch(/^[0-9a-f]{40}$/);
		expect(verify.patchIdOf(diff("rm -rf /tmp/build"))).toBe(id);
		expect(verify.patchIdOf(diff("rm -rf / tmp/build"))).not.toBe(id);
		expect(verify.patchIdOf(diff("    rm -rf /tmp/build"))).not.toBe(id);
		expect(verify.patchIdOf(diff("rm -rf /tmp/build "))).not.toBe(id);
		expect(() => verify.patchIdOf("")).toThrow("no diff");
	});

	test("the policy paths are one list, matched by directory, segment wildcard, and case", () => {
		expect(verify.policyFiles([
			".agents/skills/verify-app/SKILL.md",
			".agents/skills/verify-app/features/README.md",
			".Agents/Skills/VERIFY-app/skill.md",
			".agents/skills/verify-app/FEATURES/readme.md",
			".agents/skills/verify-app",
			".agents/skills/verify-app/features",
			".claude/skills/verify-app",
			".Claude/Skills/Verify-App",
			".codex/skills/verify-app/SKILL.md",
			".pi/skills/verify-app/features/README.md",
			".cursor/skills/verify-app/features",
			"skills/babysit-and-ship/SKILL.md",
			"skills/babysit-and-ship/references/shipping.md",
			"skills/babysit-and-ship/references/pr-body.md",
			"claude/agents/autopilot-owner.md",
			"agentic/tools/verify/cli.ts",
			"agentic/tools/verify",
			"agentic/vendor/orch/store.ts",
			"agentic/bin/agentic",
		])).toHaveLength(19);
		expect(verify.policyFiles([
			".agents/skills/verify-app/features/login.md",
			".agents/skills/verify-app/scripts/verify-app",
			".agents/skills/verify-app/scripts/SKILL.md",
			".agents/skills/verify-app/features/sub/README.md",
			".agents/skills/verify-app/scripts",
			".agents/skills/verify-app/SKILL.md.bak",
			".agents/skills/other/SKILL.md",
			"skills/verify-app/SKILL.md",
			"x/.agents/skills/verify-app/SKILL.md",
			"claude/skills/verify-app",
			".claude/skills/other",
			".claude/skills/verify-app/scripts/verify-app",
			".claude/x/skills/verify-app",
			"skills/create-verification/SKILL.md",
			"skills/babysit-and-ship/SKILLS.md",
			"claude/agents/build.md",
			"agentic/tools/verifyx/cli.ts",
			"agentic/tools/rulesets/cli.ts",
			"agentic/bin/agentic-old",
		])).toEqual([]);
	});

	test("a passing verdict other than a countersign is refused for a pull request that touches a policy path", () => {
		const touched = ["agentic/tools/verify/cli.ts"];
		for (const verdict of ["live-ui-verified", "unit-test-verified"]) expect(verify.policyRefusal(verdict, touched)).toContain("countersigned");
		for (const verdict of ["countersigned", "verifier-blocked", "verifier-failed", "type-check-only"]) expect(verify.policyRefusal(verdict, touched)).toBeUndefined();
		expect(verify.policyRefusal("live-ui-verified", [])).toBeUndefined();
	});

	test("repointing a runtime's discovery symlink to a verification skill touches a policy path", () => {
		const diff = REPOINT_DIFF;
		expect(verify.policyFiles(verify.changedPaths(diff))).toEqual([".claude/skills/verify-app"]);
		expect(verify.policyRefusal("live-ui-verified", verify.policyFiles(verify.changedPaths(diff)))).toContain("changes the verification policy (.claude/skills/verify-app)");
	});

	test("changed paths come from each file's header, old and new names alike, never from hunk content", () => {
		const diff = [
			"diff --git a/.agents/skills/verify-x/SKILL.md b/moved.md",
			"similarity index 100%",
			"rename from .agents/skills/verify-x/SKILL.md",
			"rename to moved.md",
			"diff --git a/agentic/bin/agentic b/agentic/bin/agentic",
			"old mode 100644",
			"new mode 100755",
			"diff --git a/bin.dat b/bin.dat",
			"index bdc955b..8835708 100644",
			"Binary files a/bin.dat and b/bin.dat differ",
			"diff --git a/sp ace.md b/sp ace.md",
			"index 6178079..9ddeb5c 100644",
			"--- a/sp ace.md\t",
			"+++ b/sp ace.md\t",
			"@@ -1,2 +1,2 @@",
			"--- a/agentic/tools/verify/cli.ts",
			"+++ b/claude/agents/autopilot-owner.md",
			"rename from skills/babysit-and-ship/SKILL.md",
			"diff --git \"a/tab\\tname.md\" \"b/tab\\tname.md\"",
			"deleted file mode 100644",
			"--- \"a/tab\\tname.md\"",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-z",
			"",
		].join("\n");
		expect(verify.changedPaths(diff).sort()).toEqual([".agents/skills/verify-x/SKILL.md", "agentic/bin/agentic", "bin.dat", "moved.md", "sp ace.md", "tab\tname.md"]);
		expect(() => verify.changedPaths("diff --git a/x b/y\nold mode 100644\nnew mode 100755\n")).toThrow("cannot read the changed path");
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
			{ pr: 7, sha: "aaa", verdict: "unit-test-verified", evidence: "run.log patch:p", verifier: "v1" },
			{ pr: 8, sha: "bbb", verdict: "countersigned", evidence: "https://x/msg patch:q", verifier: "coordinator" },
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
	const WHITESPACE_DIFF = DIFF.replace("+b", "+ b");
	const POLICY_DIFF = "diff --git a/agentic/tools/verify/verify.ts b/agentic/tools/verify/verify.ts\nindex 0000001..0000002 100644\n--- a/agentic/tools/verify/verify.ts\n+++ b/agentic/tools/verify/verify.ts\n@@ -1 +1 @@\n-a\n+b\n";

	function setup(head = "a".repeat(40), state = "OPEN", diff = DIFF) {
		const root = mkdtempSync(join(tmpdir(), "verify-cli-"));
		const bin = join(root, "bin");
		const repo = join(root, "repo");
		mkdirSync(bin);
		mkdirSync(repo);
		spawnSync("git", ["init", "-q"], { cwd: repo });
		const fake = { head, state, diff };
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
			changePatch: (text = OTHER_DIFF) => writeFileSync(join(root, "diff.patch"), text),
			patchId: () => spawnSync("git", ["patch-id", "--verbatim"], { input: spawnSync("cat", [join(root, "diff.patch")], { encoding: "utf8" }).stdout, encoding: "utf8" }).stdout.split(" ")[0],
			ledger: () => readLedger(join(root, "orch")),
			store: join(root, "orch"),
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

	test("a whitespace-only change to the patch voids the verdict", () => {
		const pr = setup();
		expect(pr.cli(["record", "7", "--verdict", "live-ui-verified", "--evidence", "run.log"]).status).toBe(0);
		expect(pr.cli(["status", "7"]).status).toBe(0);
		pr.changePatch(WHITESPACE_DIFF);
		const changed = pr.cli(["status", "7"]);
		expect([changed.status, changed.stdout.includes("ledger void, patch changed")]).toEqual([1, true]);
	});

	test("a pull request that touches a policy path takes no passing verdict but a countersign", () => {
		const pr = setup("a".repeat(40), "OPEN", POLICY_DIFF);
		for (const verdict of ["live-ui-verified", "unit-test-verified"]) {
			const refused = pr.cli(["record", "7", "--verdict", verdict, "--evidence", "run.log"]);
			expect([refused.status, refused.stderr.includes("changes the verification policy (agentic/tools/verify/verify.ts)"), refused.stderr.includes("countersigned")]).toEqual([1, true, true]);
		}
		expect(pr.ledger()).toEqual([]);
		expect(pr.cli(["record", "7", "--verdict", "type-check-only", "--evidence", "run.log"]).status).toBe(0);
		expect(pr.cli(["record", "7", "--verdict", "verifier-blocked", "--evidence", "run.log"]).status).toBe(0);
		expect(pr.cli(["status", "7"]).status).toBe(1);
		expect(pr.cli(["record", "7", "--verdict", "countersigned", "--patch", pr.patchId(), "--evidence", "user-message.txt"], "coordinator").status).toBe(0);
		const status = pr.cli(["status", "7"]);
		expect([status.status, status.stdout.includes("ledger pass (countersigned")]).toEqual([0, true]);
	});

	test("a repointed discovery symlink to a verification skill takes no passing verdict but a countersign", () => {
		const pr = setup("a".repeat(40), "OPEN", REPOINT_DIFF);
		const refused = pr.cli(["record", "7", "--verdict", "live-ui-verified", "--evidence", "run.log"]);
		expect([refused.status, refused.stderr.includes("changes the verification policy (.claude/skills/verify-app)")]).toEqual([1, true]);
		expect(pr.ledger()).toEqual([]);
	});

	test("status re-applies the policy refusal: a passing row written another way does not clear the gate, a countersign does", async () => {
		const pr = setup("a".repeat(40), "OPEN", POLICY_DIFF);
		// A row record would refuse, written straight into the store as anything outside record could.
		const store = openStore(pr.store);
		try {
			await store.init();
			await store.ledger.record({ pr: 7, sha: "a".repeat(40), verdict: "live-ui-verified", evidence: evidenceCell("run.log", pr.patchId()), verifier: "verifier-1" });
		} finally {
			await store.close();
		}
		const status = pr.cli(["status", "7"]);
		expect([status.status, status.stdout.includes("ledger fail, the pull request changes the verification policy, so only countersigned passes (live-ui-verified on aaaaaaaaaaaa)")]).toEqual([1, true]);
		expect(pr.cli(["record", "7", "--verdict", "verifier-blocked", "--evidence", "run.log"]).status).toBe(0);
		expect(pr.cli(["record", "7", "--verdict", "countersigned", "--patch", pr.patchId(), "--evidence", "user-message.txt"], "coordinator").status).toBe(0);
		const signed = pr.cli(["status", "7"]);
		expect([signed.status, signed.stdout.includes("ledger pass (countersigned")]).toEqual([0, true]);
	});

	test("a verification skill's feature files and drive scripts land on ordinary verdicts; its verdict rules do not", () => {
		const change = (path: string) => `diff --git a/${path} b/${path}\nindex 0000001..0000002 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
		for (const path of [".agents/skills/verify-x/features/login.md", ".agents/skills/verify-x/scripts/verify-x"]) {
			const pr = setup("a".repeat(40), "OPEN", change(path));
			expect(pr.cli(["record", "7", "--verdict", "live-ui-verified", "--evidence", "run.log"]).status).toBe(0);
			const status = pr.cli(["status", "7"]);
			expect([path, status.status, status.stdout.includes("ledger pass (live-ui-verified")]).toEqual([path, 0, true]);
		}
		for (const path of [".agents/skills/verify-x/SKILL.md", ".agents/skills/verify-x/features/README.md"]) {
			const pr = setup("a".repeat(40), "OPEN", change(path));
			const refused = pr.cli(["record", "7", "--verdict", "live-ui-verified", "--evidence", "run.log"]);
			expect([path, refused.status, refused.stderr.includes(`changes the verification policy (${path})`)]).toEqual([path, 1, true]);
			expect(pr.ledger()).toEqual([]);
		}
	});

	test("publish is gone: it is a usage error that touches neither the ledger nor GitHub", () => {
		const pr = setup();
		const publish = pr.cli(["publish", "7"]);
		expect(publish.status).toBe(2);
		expect(publish.stderr).toContain("Usage: verify <record | status> <pr>");
		expect(pr.ledger()).toEqual([]);
	});

	test("countersigned is refused without a verifier-blocked verdict for the approved patch, and passes the gate once recorded", () => {
		const pr = setup();
		const sign = (patch: string | undefined, evidence = "user-message.txt") => pr.cli(["record", "7", "--verdict", "countersigned", "--evidence", evidence, ...(patch ? ["--patch", patch] : [])], "coordinator");
		const approved = pr.patchId();
		expect(approved).toMatch(/^[0-9a-f]{40}$/);
		const refused = sign(approved);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain("no verifier-blocked verdict covers patch");
		expect(pr.ledger()).toEqual([]);

		expect(pr.cli(["record", "7", "--verdict", "verifier-failed", "--evidence", "run.log"]).status).toBe(0);
		expect(sign(approved).status).toBe(1);
		// --patch belongs to a countersign only.
		expect(pr.cli(["record", "7", "--verdict", "verifier-failed", "--evidence", "run.log", "--patch", approved]).status).toBe(2);

		expect(pr.cli(["record", "7", "--verdict", "verifier-blocked", "--evidence", "blocked-run.log"]).status).toBe(0);
		expect(pr.cli(["status", "7"]).status).toBe(1);
		const blockedLedger = pr.ledger();
		// The user's approval covers the patch shown to them: none named, or another one, is refused.
		const unnamed = sign(undefined);
		expect([unnamed.status, unnamed.stderr.includes("pass --patch")]).toEqual([1, true]);
		const other = sign("0".repeat(40));
		expect([other.status, other.stderr.includes("a changed patch needs new words from the user")]).toEqual([1, true]);
		expect(pr.ledger()).toEqual(blockedLedger);

		const signed = sign(approved);
		expect(signed.status).toBe(0);
		const status = pr.cli(["status", "7"]);
		expect([status.status, status.stdout.includes("ledger pass (countersigned")]).toEqual([0, true]);
		// orch keeps one row per head, so the countersign replaced the blocked row and carries it.
		const row = pr.ledger().at(-1)!;
		expect([pr.ledger().length, row.verdict, row.verifier]).toEqual([1, "countersigned", "coordinator"]);
		expect(blockedBy(parseEvidenceCell(row.evidence).evidence)).toEqual({ verifier: "verifier-1", evidence: "blocked-run.log" });

		// A rebase that keeps the patch can carry the countersign, blocked verdict included; a changed patch cannot.
		pr.moveHead("b".repeat(40));
		expect(sign(approved, "carry.txt").status).toBe(0);
		expect(pr.cli(["status", "7"]).status).toBe(0);
		expect(blockedBy(parseEvidenceCell(pr.ledger().at(-1)!.evidence).evidence)).toEqual({ verifier: "verifier-1", evidence: "blocked-run.log" });
		pr.moveHead("c".repeat(40));
		pr.changePatch();
		expect(sign(approved, "carry.txt").status).toBe(1);
		expect(sign(pr.patchId(), "carry.txt").status).toBe(1);
	});

	test("a merged pull request reports its ledger state but takes no verdict", () => {
		const pr = setup("d".repeat(40), "MERGED");
		const status = pr.cli(["status", "9"]);
		expect([status.status, status.stdout.includes("o/r#9 (MERGED,"), status.stdout.includes("ledger none")]).toEqual([1, true, true]);
		const refused = pr.cli(["record", "9", "--verdict", "type-check-only", "--evidence", "run.log"]);
		expect([refused.status, refused.stderr.includes("verdicts are for open pull requests")]).toEqual([1, true]);
	});
});
