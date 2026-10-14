import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REMINDER } from "./cli.ts";

// The hook runs as claude/README.md wires it: `bun --cwd <kit> <kit>/agentic/tools/skill-reminder/cli.ts
// --claude-hook` with the PreToolUse event on stdin. Each case gets its own state directory, so markers
// from one case never answer another.

const KIT = resolve(import.meta.dir, "../../..");
const CLI = join(import.meta.dir, "cli.ts");
const STATES: string[] = [];
afterAll(() => STATES.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function freshState(): string {
	const dir = mkdtempSync(join(tmpdir(), "skill-reminder-"));
	STATES.push(dir);
	return dir;
}

function hook(stdin: string, state: string, args = ["--claude-hook"]) {
	const result = spawnSync("bun", ["--cwd", KIT, CLI, ...args], { input: stdin, encoding: "utf8", timeout: 30_000, env: { ...process.env, XDG_STATE_HOME: state } });
	return { status: result.status, stdout: result.stdout.trim() };
}

function edit(path: string, options: { tool?: string; session?: string; agent?: string } = {}): string {
	const tool = options.tool ?? "Edit";
	const field = tool === "NotebookEdit" ? "notebook_path" : "file_path";
	return JSON.stringify({
		session_id: options.session ?? "s1",
		transcript_path: "/dev/null",
		cwd: "/tmp",
		hook_event_name: "PreToolUse",
		tool_name: tool,
		tool_input: { [field]: path, old_string: "a", new_string: "b" },
		...(options.agent === undefined ? {} : { agent_id: options.agent, agent_type: "build" }),
	});
}

const reminded = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: REMINDER } });

describe("skill-reminder --claude-hook", () => {
	test("the first source edit in a session is reminded, later ones are not", () => {
		const state = freshState();
		expect(hook(edit("/repo/src/a.ts"), state)).toEqual({ status: 0, stdout: reminded });
		expect(hook(edit("/repo/src/b.py", { tool: "Write" }), state)).toEqual({ status: 0, stdout: "" });
	});

	test("each subagent and each session gets its own reminder", () => {
		const state = freshState();
		expect(hook(edit("/repo/a.rs"), state).stdout).toBe(reminded);
		expect(hook(edit("/repo/a.rs", { agent: "child-1" }), state).stdout).toBe(reminded);
		expect(hook(edit("/repo/a.rs", { agent: "child-1" }), state).stdout).toBe("");
		expect(hook(edit("/repo/a.rs", { session: "s2" }), state).stdout).toBe(reminded);
	});

	test("prose and configuration edits are not reminded and leave the reminder for the first source edit", () => {
		const state = freshState();
		for (const path of ["/repo/README.md", "/repo/package.json", "/repo/rules.toml", "/repo/Makefile"]) expect(hook(edit(path), state).stdout).toBe("");
		expect(hook(edit("/repo/nb.ipynb", { tool: "NotebookEdit" }), state).stdout).toBe(reminded);
	});

	test("tools that edit no file and unreadable events print nothing and exit 0", () => {
		const state = freshState();
		const bash = JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls a.ts" } });
		for (const stdin of [bash, "not json", "[]", JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/a.ts" } })]) expect(hook(stdin, state)).toEqual({ status: 0, stdout: "" });
	});

	test("an unwritable state directory never stops the edit", () => {
		expect(hook(edit("/repo/a.ts"), "/dev/null")).toEqual({ status: 0, stdout: "" });
	});

	test("a missing or unknown flag is a usage error that exits 1, which Claude Code does not treat as a block", () => {
		expect(hook(edit("/repo/a.ts"), freshState(), [])).toEqual({ status: 1, stdout: "" });
		expect(hook(edit("/repo/a.ts"), freshState(), ["--codex-hook"])).toEqual({ status: 1, stdout: "" });
	});
});
