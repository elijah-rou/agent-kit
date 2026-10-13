import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The hook runs as Claude Code runs it: `bun cli.ts --claude-hook` with the PreToolUse event on stdin.

const CLI = join(import.meta.dir, "cli.ts");

function hook(stdin: string, args = ["--claude-hook"]) {
	const result = spawnSync("bun", [CLI, ...args], { input: stdin, encoding: "utf8", timeout: 30_000 });
	return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function bash(command: string, agent: { id?: string; type?: string } = {}): string {
	return JSON.stringify({
		session_id: "s",
		transcript_path: "/dev/null",
		cwd: "/tmp",
		permission_mode: "bypassPermissions",
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command, description: "d" },
		tool_use_id: "toolu_1",
		...(agent.id === undefined ? {} : { agent_id: agent.id }),
		...(agent.type === undefined ? {} : { agent_type: agent.type }),
	});
}

/** The deny reason the hook printed; fails unless the output is exactly Claude Code's deny decision. */
function denied(result: ReturnType<typeof hook>): string {
	expect(result.status).toBe(0);
	const output = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, unknown> };
	expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
	expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
	expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
	const reason = output.hookSpecificOutput.permissionDecisionReason;
	expect(typeof reason).toBe("string");
	return reason as string;
}

function allowed(result: ReturnType<typeof hook>): void {
	expect(result.status).toBe(0);
	expect(result.stdout).toBe("");
}

describe("git-guard --claude-hook", () => {
	test("the main session may publish", () => {
		allowed(hook(bash("git push origin agent/x")));
		allowed(hook(bash("git rebase origin/main")));
	});
	test("a main session started with --agent carries agent_type but no agent_id, and may publish", () => {
		allowed(hook(bash("git push origin agent/x", { type: "build" })));
	});
	test("a subagent may not publish or integrate", () => {
		expect(denied(hook(bash("git push origin agent/x", { id: "a1", type: "general-purpose" })))).toMatch(/child publication\/integration command: git push/);
		expect(denied(hook(bash("cd repo && git -C sub merge topic", { id: "a1", type: "build" })))).toMatch(/git merge/);
		expect(denied(hook(bash("git pull", { id: "a1" })))).toMatch(/git pull/);
	});
	test("an autopilot-owner subagent may publish its own branch", () => {
		allowed(hook(bash("git push --force-with-lease=agent/x:abc origin agent/x", { id: "a1", type: "autopilot-owner" })));
	});
	test("--no-verify is refused everywhere", () => {
		for (const agent of [{}, { id: "a1", type: "build" }, { id: "a1", type: "autopilot-owner" }]) expect(denied(hook(bash("git commit --allow-empty --no-verify -m probe", agent)))).toMatch(/--no-verify/);
	});
	test("local git and non-git commands pass in a subagent", () => {
		for (const command of ["git status", "git commit -m local", "ls -la", "bun test"]) allowed(hook(bash(command, { id: "a1", type: "build" })));
	});
	test("another tool is outside the policy", () => {
		allowed(hook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/x" }, agent_id: "a1" })));
	});
	test("an event it cannot read is denied, never allowed", () => {
		for (const [stdin, why] of [
			["not json", /stdin is not JSON/],
			["", /stdin is not JSON/],
			["[]", /not a JSON object/],
			[JSON.stringify({ tool_input: { command: "git push" } }), /tool_name is missing/],
			[JSON.stringify({ tool_name: "Bash" }), /tool_input is missing/],
			[JSON.stringify({ tool_name: "Bash", tool_input: { command: 7 } }), /tool_input.command is not a string/],
			[JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, agent_id: 3 }), /agent_id is not a string/],
			[JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, agent_id: "a", agent_type: ["autopilot-owner"] }), /agent_type is not a string/],
		] as const) expect(denied(hook(stdin))).toMatch(why);
	});
	test("invalid UTF-8 on stdin is denied as a failure", () => {
		const result = spawnSync("bun", [CLI, "--claude-hook"], { input: Buffer.from([0xff, 0xfe, 0x7b]), encoding: "utf8", timeout: 30_000 });
		expect(denied({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr })).toMatch(/git guard failed/);
	});
	test("a missing or unknown flag is a usage error, not a decision", () => {
		for (const args of [[], ["--codex-hook"], ["--claude-hook", "extra"]]) {
			const result = hook(bash("git push"), args);
			expect(result.status).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Usage: git-guard --claude-hook");
		}
	});
});
