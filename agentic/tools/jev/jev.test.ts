import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "./egress.ts";
import { taskClass, taskHint, taskHintFor } from "./jev.ts";
import { POLICY } from "./route.ts";
import { answering, options, seededCache } from "./testing.ts";

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
		expect(Date.now() - started).toBeLessThan(POLICY.deadlineMs + 500);
	});
});
