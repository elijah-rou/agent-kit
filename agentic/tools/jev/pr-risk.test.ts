import { describe, expect, test } from "bun:test";
import { HIGH_ABOVE, prDecision, prRisk, prState, RISK_EXIT } from "./pr-risk.ts";
import { answering, options } from "./testing.ts";

describe("PR risk", () => {
	test("a score above the threshold is high, one at or below it low, and no score is not scored", () => {
		expect(prDecision({ kind: "ok", probability: HIGH_ABOVE })).toEqual({ kind: "low", reason: "P(one-way door) 0.30 <= 0.3" });
		expect(prDecision({ kind: "ok", probability: 0.31 })).toEqual({ kind: "high", reason: "P(one-way door) 0.31 > 0.3" });
		expect(prDecision({ kind: "unavailable", detail: "timeout" })).toEqual({ kind: "not scored", reason: "Jev unavailable (timeout)" });
	});

	test("each risk has its own exit code, apart from errors (1) and usage (2)", () => {
		expect(RISK_EXIT).toEqual({ low: 0, high: 3, "not scored": 4 });
	});

	test("an HTTP error, a malformed answer, or no key leaves the PR not scored, never high", async () => {
		expect(prDecision(await prRisk("s", options(answering({}, 500)))).kind).toBe("not scored");
		expect(prDecision(await prRisk("s", options(answering({ type: "noul", noul: 1.5 })))).kind).toBe("not scored");
		expect(prDecision(await prRisk("s", { apiKey: undefined, timeoutMs: 1000 })).kind).toBe("not scored");
		expect(await prRisk("s", options(answering({ type: "noul", noul: 0.12 })))).toEqual({ kind: "ok", probability: 0.12 });
	});

	test("the state uses the calibrated layout", () => {
		expect(prState({ repo: "o/r", title: "T", body: "  line one\r\nline two\r\n", stat: "", diff: "" })).toContain("Body: line one\nline two\nFiles changed (0):");
		const state = prState({ repo: "o/r", title: "T", body: "b".repeat(700), stat: " a | 1 +\n b | 2 +-\n 2 files changed\n", diff: "d".repeat(6001) });
		expect(state).toMatch(/^Repository: o\/r\nSubject: T\nBody: b{600}\nFiles changed \(2\):\n a \| 1 \+\n b \| 2 \+-\n 2 files changed\nDiff \(truncated to 6000 characters\):\nd{6000}\n\[truncated\]$/);
	});
});
