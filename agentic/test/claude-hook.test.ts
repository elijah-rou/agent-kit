import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "bin", "agentic");

function repo(grantLevel: number) {
	const root = mkdtempSync(join(tmpdir(), "claude-hook-"));
	const dir = join(root, "app");
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:example/app.git"]);
	execFileSync("git", ["-C", dir, "checkout", "-q", "-b", "agent/feature"]);
	const grants = join(root, "grants.toml");
	writeFileSync(grants, `[[grant]]\nrepo = "github.com/example/app"\nlevel = ${grantLevel}\n`);
	return { dir, grants };
}

function hook(event: Record<string, unknown>, env: Record<string, string>) {
	const result = spawnSync("bun", [BIN, "claude-hook"], { input: JSON.stringify(event), env: { ...process.env, ...env, AGENTIC_JEV_THRESHOLD: "" }, encoding: "utf8" });
	return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function decision(stdout: string): string | undefined {
	return stdout ? (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision : undefined;
}

describe("Claude PreToolUse adapter", () => {
	test("an allowed call emits nothing, deferring to Claude's permission prompts", () => {
		const ws = repo(2);
		const out = hook({ session_id: "s1", cwd: ws.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin agent/feature" } }, { AGENTIC_GRANTS: ws.grants });
		expect(out.status).toBe(0);
		expect(out.stdout).toBe("");
	});

	test("pushing the default branch asks the user", () => {
		const ws = repo(4);
		const out = hook({ session_id: "s1", cwd: ws.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin HEAD:main" } }, { AGENTIC_GRANTS: ws.grants });
		expect(decision(out.stdout)).toBe("ask");
		expect(out.stdout).toContain("always-pause-default-branch");
	});

	test("a session that cannot prompt (bypass permissions) gets deny where the gate would ask", () => {
		const ws = repo(4);
		const event = { session_id: "s1", cwd: ws.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin HEAD:main" } };
		const bypass = hook({ ...event, permission_mode: "bypassPermissions" }, { AGENTIC_GRANTS: ws.grants });
		expect(decision(bypass.stdout)).toBe("deny");
		expect(bypass.stdout).toContain("always-pause-default-branch");
		expect(bypass.stdout).toContain("cannot ask");
		for (const mode of ["default", "acceptEdits", "plan"]) expect(decision(hook({ ...event, permission_mode: mode }, { AGENTIC_GRANTS: ws.grants }).stdout)).toBe("ask");
	});

	test("a subagent call (agent_id present) is a child and is denied publication", () => {
		const ws = repo(4);
		const out = hook({ session_id: "s1", agent_id: "sub-7", agent_type: "Explore", cwd: ws.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin agent/feature" } }, { AGENTIC_GRANTS: ws.grants });
		expect(decision(out.stdout)).toBe("deny");
		expect(out.stdout).toContain("children-never-publish");
	});

	test("non-shell tools emit nothing", () => {
		const ws = repo(2);
		const out = hook({ session_id: "s1", cwd: ws.dir, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "x" } }, { AGENTIC_GRANTS: ws.grants });
		expect(out.stdout).toBe("");
	});

	test("malformed hook input fails closed with an explicit deny", () => {
		const result = spawnSync("bun", [BIN, "claude-hook"], { input: "{not json", encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(decision(result.stdout.trim())).toBe("deny");
	});

	test("a hook whose evaluation blocks synchronously still answers deny before Claude's timeout", () => {
		const ws = repo(2);
		const started = Date.now();
		const out = hook({ session_id: "s1", cwd: ws.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin agent/feature" } }, { AGENTIC_GRANTS: ws.grants, AGENTIC_FAULT_HANG_MS: "30000", AGENTIC_HOOK_DEADLINE_MS: "1500" });
		expect(decision(out.stdout)).toBe("deny");
		expect(out.stdout).toContain("exceeded its deadline");
		expect(Date.now() - started).toBeLessThan(10000);
	});

	test("a malformed grants file fails closed", () => {
		const ws = repo(2);
		writeFileSync(ws.grants, "[[grant]]\nlevel = 9\n");
		const out = hook({ session_id: "s1", cwd: ws.dir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin agent/feature" } }, { AGENTIC_GRANTS: ws.grants });
		expect(decision(out.stdout)).toBe("deny");
	});
});
