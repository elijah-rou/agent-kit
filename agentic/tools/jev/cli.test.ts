import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookAnswer, promptHook } from "./cli.ts";
import type { RouteDeps } from "./route-task.ts";
import { POLICY, type Answers, type Level } from "./route.ts";

const CLI = join(import.meta.dir, "cli.ts");
const SKILLS = join(import.meta.dir, "..", "..", "..", "skills");

const answers = (level: Level, door: Answers["door"]["choice"]): Answers => ({
	door: { choice: door, confidence: 0.99, probabilities: { reversible: 0, experiment: 0, "one-way-door": 0, [door]: 0.99 } },
	level: { choice: level, confidence: 0.97, probabilities: { lookup: 0, rigor: 0, loop: 0, [level]: 0.97 } },
	model: "jev-1.13.0",
});

const deps = (answer: Answers): RouteDeps => ({
	policy: POLICY,
	classify: async () => ({ kind: "answered", answers: answer }),
	repo: async () => ({ slug: "o/r", optedOut: false }),
	env: {},
	now: Date.now,
	skillsDir: SKILLS,
});

const event = (prompt: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, cwd: "/repo", session_id: "s1" });

describe("the prompt hook delivers advice only", () => {
	test("every note the shipped policy delivers is added context, with no decision, continue, or stop reason", async () => {
		const cases: [string, Answers][] = [
			["Where does the config loader read XDG paths from?", answers("lookup", "reversible")],
			["Going to bed, keep fixing the flaky tests until CI is green", answers("loop", "one-way-door")],
			["Migrate the ledger store from JSON files to SQLite", answers("rigor", "one-way-door")],
		];
		for (const runtime of ["claude", "codex"] as const) {
			for (const [prompt, answer] of cases) {
				const { answer: stdout, record } = await promptHook(runtime, event(prompt), deps(answer));
				expect(record.noted).toBe(true);
				const output = JSON.parse(stdout!) as Record<string, unknown>;
				expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
				const specific = output.hookSpecificOutput as Record<string, unknown>;
				expect(Object.keys(specific).sort()).toEqual(["additionalContext", "hookEventName"]);
				expect(specific.hookEventName).toBe("UserPromptSubmit");
				expect(specific.additionalContext).toMatch(/^Task-(?:route note|class hint), advisory: /);
			}
		}
	});

	test("no note means no answer at all", () => {
		expect(hookAnswer(undefined)).toBeUndefined();
	});

	test("the hook process exits 0 with nothing on stdout when routing fails or is off", () => {
		const state = mkdtempSync(join(tmpdir(), "jev-hook-"));
		const env = { ...process.env, XDG_STATE_HOME: state, AGENTIC_ROUTE: "off", TYPESAFE_API_KEY: "" };
		for (const [flag, stdin] of [["--claude-hook", "not json"], ["--codex-hook", event("Migrate the ledger store from JSON files to SQLite")]] as const) {
			const result = spawnSync("bun", [CLI, "task-class", flag], { input: stdin, env, encoding: "utf8", timeout: 20_000 });
			expect(`${flag}: ${result.status} ${result.stdout}`).toBe(`${flag}: 0 `);
		}
		expect(readdirSync(join(state, "agentic", "task-route"), { recursive: true }).length).toBe(2);
	});
});
