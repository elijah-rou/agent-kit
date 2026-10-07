import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../vendor/orch/store.ts";
import { currentVerdict, evidenceCell, githubSlug, orchStore, parseEvidenceCell, readLedger, rowForHead, statusFor } from "./verify.ts";

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

	test("the status mirrors the verdict and links https evidence only", () => {
		expect(statusFor("unit-test-verified", "0123456789abcdef", "https://example.com/run/1")).toEqual({ state: "success", description: "unit-test-verified, patch 0123456789ab", targetUrl: "https://example.com/run/1" });
		expect(statusFor("verifier-blocked", "0123456789abcdef", ".audit/run.log")).toEqual({ state: "failure", description: "verifier-blocked, patch 0123456789ab" });
		expect(evidenceCell(".audit/run.log", "abc")).toBe(".audit/run.log patch:abc");
		expect(parseEvidenceCell(evidenceCell("https://x/run 1", "0f3a"))).toEqual({ evidence: "https://x/run 1", patchId: "0f3a" });
		expect(() => parseEvidenceCell("run.log")).toThrow("no patch ID");
	});

	test("publish uses the latest row for the current head only", () => {
		const ledger = [
			{ pr: 7, sha: "aaa", verdict: "unit-test-verified" },
			{ pr: 7, sha: "bbb", verdict: "verifier-failed" },
			{ pr: 7, sha: "aaa", verdict: "verifier-blocked" },
		];
		expect(rowForHead(ledger, 7, "aaa")?.verdict).toBe("verifier-blocked");
		expect(rowForHead(ledger, 7, "ccc")).toBeUndefined();
	});

	test("reads the ledger orch writes, and treats a missing ledger as no verdicts", async () => {
		const dir = join(mkdtempSync(join(tmpdir(), "verify-")), "orch");
		expect(readLedger(dir)).toEqual([]);
		const store = openStore(dir);
		try {
			await store.init();
			await store.ledger.record({ pr: 7, sha: "aaa", verdict: "unit-test-verified", evidence: "run.log patch:p", verifier: "v1" });
		} finally {
			await store.close();
		}
		expect(readLedger(dir)).toEqual([{ pr: 7, sha: "aaa", verdict: "unit-test-verified", evidence: "run.log patch:p" }]);
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
