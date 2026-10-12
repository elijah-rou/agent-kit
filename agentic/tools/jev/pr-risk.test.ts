import { describe, expect, test } from "bun:test";
import { HOLD_ABOVE, prDecision, prRisk, prState } from "./pr-risk.ts";
import { answering, options } from "./testing.ts";

describe("PR risk", () => {
	test("only a score at or below the threshold clears a PR", () => {
		expect(prDecision({ kind: "ok", probability: HOLD_ABOVE }).hold).toBe(false);
		expect(prDecision({ kind: "ok", probability: 0.31 }).hold).toBe(true);
		expect(prDecision({ kind: "unavailable", detail: "timeout" })).toEqual({ hold: true, reason: "Jev unavailable (timeout)" });
	});

	test("an HTTP error, a malformed answer, or no key holds the PR", async () => {
		expect(prDecision(await prRisk("s", options(answering({}, 500)))).hold).toBe(true);
		expect(prDecision(await prRisk("s", options(answering({ type: "noul", noul: 1.5 })))).hold).toBe(true);
		expect(prDecision(await prRisk("s", { apiKey: undefined, timeoutMs: 1000 })).hold).toBe(true);
		expect(await prRisk("s", options(answering({ type: "noul", noul: 0.12 })))).toEqual({ kind: "ok", probability: 0.12 });
	});

	test("the state uses the calibrated layout", () => {
		expect(prState({ repo: "o/r", title: "T", body: "  line one\r\nline two\r\n", stat: "", diff: "" })).toContain("Body: line one\nline two\nFiles changed (0):");
		const state = prState({ repo: "o/r", title: "T", body: "b".repeat(700), stat: " a | 1 +\n b | 2 +-\n 2 files changed\n", diff: "d".repeat(6001) });
		expect(state).toMatch(/^Repository: o\/r\nSubject: T\nBody: b{600}\nFiles changed \(2\):\n a \| 1 \+\n b \| 2 \+-\n 2 files changed\nDiff \(truncated to 6000 characters\):\nd{6000}\n\[truncated\]$/);
	});
});
