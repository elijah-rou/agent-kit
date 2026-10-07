import { describe, expect, test } from "bun:test";
import { currentVerdict, evidenceCell, statusFor } from "./verify.ts";

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
});
