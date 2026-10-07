import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HINT_DEADLINE_MS, HOLD_ABOVE, isPublic, isTask, prDecision, prRisk, prState, sendable, taskClass, taskHint, taskHintFor, type FetchLike } from "./jev.ts";

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
		expect(prState({ repo: "o/r", title: "T", body: "  line one\r\nline two\r\n", stat: "", diff: "" })).toContain("Body: line one\nline two\nFiles changed (0):");
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

function seededCache(slug: string, entry: { visibility: string; at: number }): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(tmpdir(), "jev-cache-"));
	mkdirSync(join(home, "agentic"), { recursive: true });
	writeFileSync(join(home, "agentic", "repo-visibility.json"), JSON.stringify({ [slug]: entry }));
	return { XDG_CACHE_HOME: home, TYPESAFE_API_KEY: "test-key" };
}

describe("what leaves the machine", () => {
	test("credential-shaped text is never sent, and home directories are redacted", () => {
		expect(sendable(`rotate the key ${"sk-" + "a".repeat(24)} in config`)).toBeUndefined();
		expect(sendable(`use ${"ghp_" + "b".repeat(30)}`)).toBeUndefined();
		expect(sendable("set password=hunter2hunter2 in the env file")).toBeUndefined();
		expect(sendable("rename the token parser module and update its callers")).toBe("rename the token parser module and update its callers");
		const [mac, linux] = ["/" + "Users/someone", "/" + "home/dev"];
		expect(sendable(`fix the build script in ${mac}/src/app and ${linux}/x`)).toBe("fix the build script in ~/src/app and ~/x");
	});

	test("a prompt with a credential gives no hint and makes no call", async () => {
		let calls = 0;
		const fetch: FetchLike = async () => (calls++, new Response("{}"));
		expect(await taskHintFor(`please rotate the deploy token ${"ghp_" + "c".repeat(30)} today`, import.meta.dir, seededCache("elijah-rou/agent-kit", { visibility: "PUBLIC", at: Date.now() }), fetch)).toBeUndefined();
		expect(calls).toBe(0);
	});

	test("a hanging Jev never holds a prompt past the deadline", async () => {
		const hanging: FetchLike = (_input, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
		const started = Date.now();
		const repo = mkdtempSync(join(tmpdir(), "jev-repo-"));
		execFileSync("git", ["init", "-q", repo]);
		execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:o/r.git"]);
		let reached = false;
		const watched: FetchLike = (input, init) => ((reached = true), hanging(input, init));
		const hint = await taskHintFor("Store verdicts in a new SQLite database and migrate rows", repo, seededCache("o/r", { visibility: "PUBLIC", at: Date.now() }), watched);
		expect(reached).toBe(true);
		expect(hint).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(HINT_DEADLINE_MS + 500);
	});

	test("a future-dated or failed cache entry is not trusted as public", async () => {
		const future = seededCache("o/r", { visibility: "PUBLIC", at: Date.now() + 10 * 86_400_000 });
		expect(await isPublic("o/r", { env: future, timeoutMs: 0 })).toBe(false);
		const failed = seededCache("o/r", { visibility: "UNKNOWN", at: Date.now() });
		expect(await isPublic("o/r", { env: failed, timeoutMs: 0 })).toBe(false);
		const fresh = seededCache("o/r", { visibility: "PUBLIC", at: Date.now() });
		expect(await isPublic("o/r", { env: fresh, timeoutMs: 0 })).toBe(true);
		expect(await isPublic("o/r", { env: fresh, fresh: true, timeoutMs: 0 })).toBe(false);
	});
});
