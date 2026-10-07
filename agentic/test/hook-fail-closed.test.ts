import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Claude Code lets a tool run when its hook fails to start or exits with an error, so every
// startup failure must still print a deny decision and exit 0.
const AGENTIC = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "agentic-fail-closed-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const event = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: root });

function hook(script: string, env: NodeJS.ProcessEnv) {
	const result = spawnSync("/bin/sh", [script], { input: event, env, encoding: "utf8" });
	return { status: result.status, decision: JSON.parse(result.stdout || "{}").hookSpecificOutput?.permissionDecision, reason: JSON.parse(result.stdout || "{}").hookSpecificOutput?.permissionDecisionReason };
}

describe("claude-hook startup failures", () => {
	test("a policy layer that fails to load denies instead of exiting with an error", () => {
		// Bun can auto-install a missing package from its cache, so a module that throws on import
		// stands in for a broken dependency.
		const copy = join(root, "kit", "agentic");
		cpSync(AGENTIC, copy, { recursive: true });
		const pipeline = join(copy, "src", "pipeline.ts");
		writeFileSync(pipeline, `throw new Error("simulated load failure");\n${readFileSync(pipeline, "utf8")}`);
		const result = hook(join(copy, "bin", "claude-hook"), process.env);
		expect(result).toMatchObject({ status: 0, decision: "deny" });
		expect(result.reason).toContain("failed to load, failing closed: simulated load failure");
	});

	test("no bun on PATH or in the known locations denies", () => {
		const result = hook(join(AGENTIC, "bin", "claude-hook"), { PATH: "/usr/bin:/bin", HOME: root });
		expect(result).toMatchObject({ status: 0, decision: "deny" });
		expect(result.reason).toContain("bun was not found");
	});

	test("without bun on PATH, the bun beside bootstrap's agent-kit link is found", () => {
		const tools = join(root, "tools");
		mkdirSync(join(tools, "bin"), { recursive: true });
		symlinkSync(join(AGENTIC, ".."), join(tools, "agent-kit"));
		symlinkSync(process.execPath, join(tools, "bin", "bun"));
		const result = hook(join(tools, "agent-kit", "agentic", "bin", "claude-hook"), { PATH: "/usr/bin:/bin", HOME: root, AGENTIC_HOME: root, AGENTIC_NO_KEYCHAIN: "1", AGENTIC_JEV_THRESHOLD: "" });
		expect(result.status).toBe(0);
		expect(result.reason ?? "").not.toContain("bun was not found");
	});

	test("a missing CLI denies", () => {
		const lone = join(root, "lone");
		cpSync(join(AGENTIC, "bin", "claude-hook"), join(lone, "claude-hook"));
		expect(hook(join(lone, "claude-hook"), process.env)).toMatchObject({ status: 0, decision: "deny" });
	});
});
