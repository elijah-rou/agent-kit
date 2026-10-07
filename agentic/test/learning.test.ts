import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, consolidate, learningDir, reflectionDue, withLock, writeSessionFile, type SessionEntry } from "../src/learning/learning.ts";

const entry = (session: string, date: string, text: string, overrides: Partial<SessionEntry> = {}): SessionEntry => ({
	kind: "repo",
	text,
	evidence: { session, date },
	enforceable: false,
	...overrides,
});

const repo = () => mkdtempSync(join(tmpdir(), "learning-"));

describe("learning loop (R13)", () => {
	test("each session writes only its own file", () => {
		const root = repo();
		const a = writeSessionFile(root, "s-a", [entry("s-a", "2026-10-01", "Run bun test before committing")]);
		const b = writeSessionFile(root, "s-b", [entry("s-b", "2026-10-02", "Prefer small PRs")]);
		expect(a).not.toBe(b);
		expect(() => writeSessionFile(root, "../escape", [])).toThrow();
	});

	test("enforceable learnings go to the correct backlog, not to candidates", () => {
		const root = repo();
		writeSessionFile(root, "s-a", [entry("s-a", "2026-10-01", "Never use em dashes", { enforceable: true })]);
		const report = consolidate(root, new Date("2026-10-02"));
		expect(report.newBacklog).toBe(1);
		const backlog = JSON.parse(readFileSync(join(learningDir(root), "backlog.json"), "utf8"));
		expect(backlog[0].evidence[0].session).toBe("s-a");
		expect(JSON.parse(readFileSync(join(learningDir(root), "state.json"), "utf8")).candidates).toEqual([]);
	});

	test("a learning seen in two sessions is ready for review; only approval promotes it", () => {
		const root = repo();
		writeSessionFile(root, "s-a", [entry("s-a", "2026-10-01", "Ask before renaming public APIs")]);
		expect(consolidate(root, new Date("2026-10-01")).readyForReview).toEqual([]);
		writeSessionFile(root, "s-b", [entry("s-b", "2026-10-03", "ask before renaming public APIs!")]);
		const report = consolidate(root, new Date("2026-10-03"));
		expect(report.readyForReview.length).toBe(1);
		const learned = readFileSync(join(learningDir(root), "LEARNED.md"), "utf8");
		expect(learned).toContain("none yet");
		approve(root, report.readyForReview[0]);
		const after = readFileSync(join(learningDir(root), "LEARNED.md"), "utf8");
		expect(after).toContain("Ask before renaming public APIs");
		expect(after).toContain("s-a (2026-10-01)");
		expect(after).toContain("s-b (2026-10-03)");
	});

	test("approval refuses a learning that is not ready", () => {
		const root = repo();
		writeSessionFile(root, "s-a", [entry("s-a", "2026-10-01", "Use the staging profile")]);
		consolidate(root, new Date("2026-10-01"));
		const state = JSON.parse(readFileSync(join(learningDir(root), "state.json"), "utf8"));
		expect(() => approve(root, state.candidates[0].id)).toThrow("only ready-for-review");
	});

	test("unconfirmed candidates expire after the window", () => {
		const root = repo();
		writeSessionFile(root, "s-a", [entry("s-a", "2026-08-01", "Pin the node version")]);
		consolidate(root, new Date("2026-08-02"));
		expect(consolidate(root, new Date("2026-10-07")).expired.length).toBe(1);
	});

	test("global learnings become a proposal, never an edit to instructions", () => {
		const root = repo();
		for (const s of ["s-a", "s-b"]) writeSessionFile(root, s, [entry(s, "2026-10-01", "Lead with the answer", { kind: "global" })]);
		const report = consolidate(root, new Date("2026-10-02"));
		approve(root, report.readyForReview[0]);
		expect(readFileSync(join(learningDir(root), "proposed-global.md"), "utf8")).toContain("Lead with the answer");
		expect(readFileSync(join(learningDir(root), "LEARNED.md"), "utf8")).toContain("none yet");
	});

	test("a malformed session file is reported and skipped whole", () => {
		const root = repo();
		mkdirSync(join(learningDir(root), "sessions"), { recursive: true });
		writeFileSync(join(learningDir(root), "sessions", "bad.json"), JSON.stringify([{ kind: "repo", text: "x" }]));
		const report = consolidate(root, new Date("2026-10-02"));
		expect(report.malformed[0]).toContain("evidence");
		expect(report.sessionsProcessed).toEqual([]);
	});

	test("files already processed are not counted twice", () => {
		const root = repo();
		writeSessionFile(root, "s-a", [entry("s-a", "2026-10-01", "Keep commits small")]);
		consolidate(root, new Date("2026-10-01"));
		expect(consolidate(root, new Date("2026-10-01")).sessionsProcessed).toEqual([]);
	});

	test("the consolidator lock admits one writer and replaces a dead holder's lock", () => {
		const root = repo();
		const dir = learningDir(root);
		const inner = () => withLock(dir, () => "inner");
		expect(() => withLock(dir, inner)).toThrow("consolidator lock held");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "consolidator.lock"), "999999");
		expect(withLock(dir, () => "ok")).toBe("ok");
		expect(existsSync(join(dir, "consolidator.lock"))).toBe(false);
	});

	test("concurrent session ends from separate processes produce separate files", async () => {
		const root = repo();
		const script = `import { writeSessionFile } from ${JSON.stringify(join(import.meta.dir, "..", "src", "learning", "learning.ts"))}; const id = process.argv[2]; writeSessionFile(${JSON.stringify(root)}, id, [{ kind: "repo", text: "Learned in " + id, evidence: { session: id, date: "2026-10-07" }, enforceable: false }]);`;
		const file = join(root, "writer.ts");
		writeFileSync(file, script);
		await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				new Promise<void>((resolve, reject) => spawn("bun", [file, `s-${i}`]).on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))),
			),
		);
		const report = consolidate(root, new Date("2026-10-07"));
		expect(report.sessionsProcessed.length).toBe(6);
	});

	test("cadence: at least 10 turns and 120 minutes since the last run", () => {
		const now = new Date("2026-10-07T12:00:00Z");
		expect(reflectionDue({ turnsSinceLast: 9, lastRunAt: null }, now)).toBe(false);
		expect(reflectionDue({ turnsSinceLast: 10, lastRunAt: null }, now)).toBe(true);
		expect(reflectionDue({ turnsSinceLast: 30, lastRunAt: "2026-10-07T11:00:00Z" }, now)).toBe(false);
		expect(reflectionDue({ turnsSinceLast: 30, lastRunAt: "2026-10-07T09:59:00Z" }, now)).toBe(true);
	});
});
