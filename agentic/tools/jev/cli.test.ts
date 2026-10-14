import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
		for (const [prompt, answer] of cases) {
			const { answer: stdout, record } = await promptHook(event(prompt), deps(answer));
			expect(record.noted).toBe(true);
			const output = JSON.parse(stdout!) as Record<string, unknown>;
			expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
			const specific = output.hookSpecificOutput as Record<string, unknown>;
			expect(Object.keys(specific).sort()).toEqual(["additionalContext", "hookEventName"]);
			expect(specific.hookEventName).toBe("UserPromptSubmit");
			expect(specific.additionalContext).toMatch(/^Task-(?:route note|class hint), advisory: /);
		}
	});

	test("no note means no answer at all", () => {
		expect(hookAnswer(undefined)).toBeUndefined();
	});

	test("the hook process exits 0 with nothing on stdout when routing fails or is off", () => {
		const state = mkdtempSync(join(tmpdir(), "jev-hook-"));
		const env = { ...process.env, XDG_STATE_HOME: state, AGENTIC_ROUTE: "off", TYPESAFE_API_KEY: "" };
		for (const [flag, stdin] of [["--claude-hook", "not json"], ["--claude-hook", event("Migrate the ledger store from JSON files to SQLite")]] as const) {
			const result = spawnSync("bun", [CLI, "task-class", flag], { input: stdin, env, encoding: "utf8", timeout: 20_000 });
			expect(`${flag}: ${result.status} ${result.stdout}`).toBe(`${flag}: 0 `);
		}
		expect(readdirSync(join(state, "agentic", "task-route"), { recursive: true }).length).toBe(2);
	});
});

// pr-risk against a fake gh (and, on macOS, a fake keychain that has no key), so nothing reaches
// GitHub or TypeSafe: each case that cannot be scored must say so and exit 4, apart from high (3).
describe("agentic jev pr-risk, end to end", () => {
	function prRisk(visibility: string, diff: string) {
		const root = mkdtempSync(join(tmpdir(), "jev-cli-"));
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(root, "view.json"), JSON.stringify({ title: "T", body: "B" }));
		writeFileSync(join(root, "diff.patch"), diff);
		writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n"repo view") echo ${visibility};;\n"pr view") cat "${root}/view.json";;\n"pr diff") cat "${root}/diff.patch";;\n*) echo "fake gh: unexpected gh $*" >&2; exit 1;;\nesac\n`);
		writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n");
		for (const name of ["gh", "security"]) chmodSync(join(bin, name), 0o755);
		const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CACHE_HOME: join(root, "cache"), TYPESAFE_API_KEY: "", USER: "jev-cli-test" };
		return spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "pr-risk", "7", "--repo", "o/r"], { cwd: root, encoding: "utf8", env });
	}
	const DIFF = "diff --git a/x b/x\nindex 0000001..0000002 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

	test("a private repository is not scored, exit 4, and its diff is never read", () => {
		const result = prRisk("PRIVATE", DIFF);
		expect([result.status, result.stdout.trim()]).toEqual([4, "o/r#7: not scored, not a public repository, so Jev does not see its diff"]);
	});

	test("credential-shaped text is not scored, exit 4", () => {
		const result = prRisk("PUBLIC", DIFF.replace("+b", `+token = ghp_${"a".repeat(36)}`));
		expect([result.status, result.stdout.trim()]).toEqual([4, "o/r#7: not scored, the PR contains credential-shaped text, so it is not sent to Jev"]);
	});

	test("Jev without a key is not scored, exit 4, never high", () => {
		const result = prRisk("PUBLIC", DIFF);
		expect([result.status, result.stdout.trim()]).toEqual([4, "o/r#7: not scored, Jev unavailable (no TypeSafe key)"]);
	});

	test("the help documents every exit code", () => {
		const help = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "--help"], { encoding: "utf8" });
		expect(help.stdout).toMatch(/low +exit 0 /);
		expect(help.stdout).toMatch(/high +exit 3 /);
		expect(help.stdout).toMatch(/not scored +exit 4 /);
		expect(help.stdout).toContain("Exit 1 is an error");
		expect(help.stdout).not.toContain("waits for the user");
	});
});
