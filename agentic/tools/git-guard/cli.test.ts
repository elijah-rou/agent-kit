import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Each case runs the guard directly, `bun --cwd <kit> <kit>/agentic/tools/git-guard/cli.ts --claude-hook`
// with the PreToolUse event on stdin, using the Bun on PATH. Bootstrap's hook entry (in claude/README.md)
// also passes --cwd set to the kit, but first tests that the guard file exists and runs bootstrap's own Bun;
// these tests do not run that entry. Claude Code starts the hook in the session's project, so every case
// runs from a scratch project whose bunfig.toml preloads a script that prints, as an ordinary Bun
// project's might. Without --cwd, Bun would load it and the printed line would break the decision.

const KIT = resolve(import.meta.dir, "../../..");
const CLI = join(import.meta.dir, "cli.ts");
const PROJECT = mkdtempSync(join(tmpdir(), "git-guard-project-"));
writeFileSync(join(PROJECT, "preload.ts"), 'console.log("project preload ran");\n');
writeFileSync(join(PROJECT, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

function run(argv: string[], stdin: string | Buffer) {
	const result = spawnSync("bun", argv, { cwd: PROJECT, input: stdin, encoding: "utf8", timeout: 30_000 });
	return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function hook(stdin: string | Buffer, args = ["--claude-hook"]) {
	return run(["--cwd", KIT, CLI, ...args], stdin);
}

function bash(command: string, agent: { id?: string; type?: string } = {}, tool = "Bash"): string {
	return JSON.stringify({
		session_id: "s",
		transcript_path: "/dev/null",
		cwd: "/tmp",
		permission_mode: "bypassPermissions",
		hook_event_name: "PreToolUse",
		tool_name: tool,
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
	test("skipping hooks is refused everywhere", () => {
		for (const agent of [{}, { id: "a1", type: "build" }, { id: "a1", type: "autopilot-owner" }]) {
			expect(denied(hook(bash("git commit --allow-empty --no-verify -m probe", agent)))).toMatch(/skipping git hooks with --no-verify/);
		}
	});
	test("git commit -n, a skip variable, and a hooks override are refused everywhere", () => {
		for (const agent of [{}, { id: "a1", type: "build" }, { id: "a1", type: "autopilot-owner" }]) {
			expect(denied(hook(bash("git commit -nm probe", agent)))).toMatch(/skipping git hooks with -n/);
			expect(denied(hook(bash("HUSKY=0 git commit -m probe", agent)))).toMatch(/skipping git hooks with a hook manager's skip variable/);
			expect(denied(hook(bash("git -c core.hooksPath=/dev/null commit -m probe", agent)))).toMatch(/skipping git hooks by setting or unsetting core.hooksPath/);
			expect(denied(hook(bash("/usr/bin/git commit --no-verify -m probe", agent)))).toMatch(/skipping git hooks with --no-verify/);
		}
	});
	test("a subagent may not merge a pull request with gh or publish through git's absolute path; an owner may", () => {
		expect(denied(hook(bash("gh pr merge 3 --squash", { id: "a1", type: "build" })))).toMatch(/child publication\/integration command: gh pr merge/);
		expect(denied(hook(bash("/usr/bin/git push origin agent/x", { id: "a1", type: "build" })))).toMatch(/child publication\/integration command: git push/);
		for (const command of ["gh pr merge 3 --squash", "/usr/bin/git push origin agent/x"]) allowed(hook(bash(command, { id: "a1", type: "autopilot-owner" })));
		for (const command of ["gh pr view 3", "git merge-base a b", "git config user.name x"]) allowed(hook(bash(command, { id: "a1", type: "build" })));
	});
	test("local git and non-git commands pass in a subagent", () => {
		for (const command of ["git status", "git commit -m local", "ls -la", "bun test"]) allowed(hook(bash(command, { id: "a1", type: "build" })));
	});
	test("a shell fed from a pipe or started with no input passes, in the main session and a subagent", () => {
		for (const agent of [{}, { id: "a1", type: "build" }]) for (const command of ["printf 'echo hi\\n' | sh", "bash -l"]) allowed(hook(bash(command, agent)));
	});
	test("Monitor and PowerShell commands get the same policy as Bash", () => {
		expect(denied(hook(bash("git push origin agent/x", { id: "a1", type: "build" }, "Monitor")))).toMatch(/git push/);
		expect(denied(hook(bash("git commit --no-verify -m x", {}, "Monitor")))).toMatch(/skipping git hooks/);
		expect(denied(hook(bash("git push origin agent/x", { id: "a1", type: "build" }, "PowerShell")))).toMatch(/git push/);
		expect(denied(hook(bash("git commit --no-verify -m x", {}, "PowerShell")))).toMatch(/skipping git hooks/);
		allowed(hook(bash("tail -f build.log", { id: "a1", type: "build" }, "Monitor")));
		allowed(hook(bash("git push origin agent/x", { id: "a1", type: "autopilot-owner" }, "Monitor")));
	});
	test("a Monitor watching a WebSocket runs no command and passes", () => {
		allowed(hook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Monitor", tool_input: { description: "d", ws: { url: "wss://example.invalid" } }, agent_id: "a1" })));
	});
	test("a tool that runs no shell command is outside the policy, even with git text in its input", () => {
		allowed(hook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/x.sh", content: "git push --no-verify" }, agent_id: "a1" })));
	});
	test("the project's bunfig.toml preload would corrupt the decision without --cwd, and does not with it", () => {
		const exposed = run([CLI, "--claude-hook"], bash("git commit --no-verify -m x"));
		expect(exposed.stdout.startsWith("project preload ran")).toBe(true);
		expect(denied(hook(bash("git commit --no-verify -m x")))).toMatch(/skipping git hooks/);
	});
	test("an event it cannot read is denied, never allowed", () => {
		for (const [stdin, why] of [
			["not json", /stdin is not JSON/],
			["", /stdin is not JSON/],
			["[]", /not a JSON object/],
			[JSON.stringify({ tool_input: { command: "git push" } }), /tool_name is missing/],
			[JSON.stringify({ tool_name: "Bash" }), /tool_input is missing/],
			[JSON.stringify({ tool_name: "Bash", tool_input: { command: 7 } }), /tool_input.command is not a string/],
			[JSON.stringify({ tool_name: "Monitor", tool_input: { description: "d" } }), /tool_input.command is not a string/],
			[JSON.stringify({ tool_name: "PowerShell", tool_input: [] }), /tool_input is missing/],
			[JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, agent_id: 3 }), /agent_id is not a string/],
			[JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, agent_id: "a", agent_type: ["autopilot-owner"] }), /agent_type is not a string/],
		] as const) expect(denied(hook(stdin))).toMatch(why);
	});
	test("invalid UTF-8 on stdin is denied as a failure", () => {
		expect(denied(hook(Buffer.from([0xff, 0xfe, 0x7b])))).toMatch(/git guard failed/);
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
