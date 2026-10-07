/**
 * Runs one Claude PreToolUse evaluation off the main thread, so the hook's watchdog can answer
 * even if evaluation blocks synchronously (for example a filesystem call on an automounted
 * path). Claude lets a tool proceed when a hook times out, so the hook must never block.
 *
 * AGENTIC_FAULT_HANG_MS is a fault-injection switch used by test/claude-hook.test.ts: it blocks
 * this worker synchronously for that long before evaluating.
 */
import { recordDecision, evaluateToolCall } from "./pipeline.ts";
import { recordPushes, sessionFromEnv } from "./facts.ts";
import { jevFilterFromConfig } from "./jev-filter.ts";

declare const self: { onmessage: ((event: { data: string }) => void) | null; postMessage(message: unknown): void };

self.onmessage = async (event) => {
	try {
		const hang = Number(process.env.AGENTIC_FAULT_HANG_MS ?? 0);
		if (hang > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hang);
		const hookEvent = JSON.parse(event.data) as { tool_name?: string; tool_input?: unknown; cwd?: string; agent_id?: string; session_id?: string };
		const env = { ...process.env, ...(hookEvent.agent_id ? { AGENTIC_CHILD: "1" } : {}) };
		const session = sessionFromEnv(env, "claude");
		session.principalId = hookEvent.agent_id ? `claude:${hookEvent.session_id}:${hookEvent.agent_id}` : `claude:${hookEvent.session_id ?? "unknown"}`;
		const result = await evaluateToolCall({ toolName: hookEvent.tool_name ?? "", input: hookEvent.tool_input, cwd: hookEvent.cwd ?? process.cwd() }, { session, env, jev: jevFilterFromConfig(env) });
		const input = hookEvent.tool_input as { command?: unknown; file_path?: unknown };
		recordDecision(env, String(input?.command ?? (input?.file_path !== undefined ? `${hookEvent.tool_name} ${input.file_path}` : hookEvent.tool_name ?? "")), result);
		// An ask may still be approved, so anything not denied counts as pushed by this session.
		if (result.decision !== "deny") recordPushes(env, session.principalId, result.pushes ?? []);
		self.postMessage({ ok: true, result });
	} catch (error) {
		self.postMessage({ ok: false, error: (error as Error).message });
	}
};
