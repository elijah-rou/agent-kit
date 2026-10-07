import { describe, expect, test } from "bun:test";
import { HOLD_ABOVE, isTask, prDecision, prRisk, prState, taskClass, taskHint, type FetchLike } from "./jev.ts";

const answering = (q: unknown, status = 200): FetchLike => async () => new Response(JSON.stringify({ answers: { q } }), { status });
const options = (fetch: FetchLike) => ({ apiKey: "test-key", timeoutMs: 1000, fetch });

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
		const state = prState({ repo: "o/r", title: "T", body: "b".repeat(700), stat: " a | 1 +\n b | 2 +-\n 2 files changed\n", diff: "d".repeat(6001) });
		expect(state).toMatch(/^Repository: o\/r\nSubject: T\nBody: b{600}\nFiles changed \(2\):\n a \| 1 \+\n b \| 2 \+-\n 2 files changed\nDiff \(truncated to 6000 characters\):\nd{6000}\n\[truncated\]$/);
	});
});

describe("task class", () => {
	test("hints only for a one-way door or an unsure answer", () => {
		expect(taskHint({ kind: "ok", choice: "reversible", confidence: 0.95 })).toBeUndefined();
		expect(taskHint({ kind: "ok", choice: "experiment", confidence: 0.8 })).toBeUndefined();
		expect(taskHint({ kind: "ok", choice: "reversible", confidence: 0.79 })).toContain("is unsure (reversible, confidence 0.79)");
		expect(taskHint({ kind: "ok", choice: "one-way-door", confidence: 0.99 })).toContain("one-way door");
		expect(taskHint({ kind: "unavailable", detail: "timeout" })).toBeUndefined();
	});

	test("a failed or malformed call gives no hint", async () => {
		expect(taskHint(await taskClass("t", options(answering({}, 429))))).toBeUndefined();
		expect(taskHint(await taskClass("t", options(answering({ type: "choice", choice: "other", confidence: 0.1 }))))).toBeUndefined();
		expect(await taskClass("t", options(answering({ type: "choice", choice: "one-way-door", confidence: 0.6 })))).toEqual({ kind: "ok", choice: "one-way-door", confidence: 0.6 });
	});

	test("short follow-ups are not tasks", () => {
		expect(isTask("yes, continue")).toBe(false);
		expect(isTask("Change the launcher's languages subcommand to a flag")).toBe(true);
	});
});
