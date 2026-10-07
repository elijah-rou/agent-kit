import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../vendor/orch/store.ts";
import { currentVerdict, evidenceCell, githubSlug, orchStore, readLedger, statusFor } from "./verify.ts";

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
		expect(readLedger(dir)).toEqual([{ pr: 7, sha: "aaa", verdict: "unit-test-verified" }]);
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
