/**
 * Runs every tool call through the agentic policy layer (agentic/): classify, Jev for unreadable
 * commands, Cedar over the user's grants, then enforce.
 *
 * - Deny blocks with the policy ID. Ask uses a confirm dialog when Pi has a UI; without one it
 *   blocks with the reason. A handler error blocks the tool (Pi's fail-safe), so the gate fails closed.
 * - /agentic-raise <0-4>: a user-typed, session-scoped autonomy raise, capped by the grant,
 *   persisted on the session branch, and logged.
 * - Jev is configured in ~/.config/agentic/config.toml; the key comes from the keychain.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionFromEnv } from "../../agentic/src/facts.ts";
import { jevFilterFromConfig } from "../../agentic/src/jev-filter.ts";
import { evaluateToolCall, recordDecision } from "../../agentic/src/pipeline.ts";

const RAISE_ENTRY = "agentic-raise";

interface RaiseEntry {
	level: number;
	at: string;
}

function describeCall(toolName: string, input: unknown): string {
	const fields = input as { command?: unknown; path?: unknown; file_path?: unknown } | undefined;
	if (typeof fields?.command === "string") return fields.command;
	const path = fields?.path ?? fields?.file_path;
	return path === undefined ? toolName : `${toolName} ${String(path)}`;
}

export default function agenticPolicyGate(pi: ExtensionAPI): void {
	let sessionRaise = 0;

	pi.on("session_start", (_event, ctx) => {
		sessionRaise = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === RAISE_ENTRY) sessionRaise = (entry.data as RaiseEntry).level;
		}
	});

	pi.registerCommand("agentic-raise", {
		description: "Raise this session's autonomy level (0-4), within your grant",
		handler: async (args, ctx) => {
			const level = Number(args.trim());
			if (!Number.isInteger(level) || level < 0 || level > 4) {
				ctx.ui.notify("usage: /agentic-raise <0-4>", "error");
				return;
			}
			sessionRaise = level;
			pi.appendEntry<RaiseEntry>(RAISE_ENTRY, { level, at: new Date().toISOString() });
			recordDecision(process.env, `/agentic-raise ${level}`, { decision: "allow", steps: [], reason: `user raised session autonomy to A${level} (capped by grant)`, policies: [], outsidePolicy: false });
			ctx.ui.notify(`Session autonomy raised to A${level} (capped by your grant)`, "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const env = { ...process.env, AGENTIC_SESSION_RAISE: String(sessionRaise) };
		const session = sessionFromEnv(env, "pi");
		session.principalId = env.AGENTIC_AGENT_ID ?? `pi:${ctx.sessionManager.getSessionId?.() ?? process.pid}`;
		const result = await evaluateToolCall({ toolName: event.toolName, input: event.input, cwd: ctx.cwd }, { session, env, jev: jevFilterFromConfig(env) });
		const command = describeCall(event.toolName, event.input);
		recordDecision(env, command, result);
		if (result.decision === "allow") return undefined;
		const label = `[agentic] ${result.reason}${result.policies.length ? ` (policies: ${result.policies.join(", ")})` : ""}`;
		if (result.decision === "deny") return { block: true, reason: label };
		if (ctx.hasUI) {
			const approved = await ctx.ui.confirm("Agentic policy: approval needed", `${command}\n\n${result.reason}`);
			recordDecision(env, command, { ...result, decision: approved ? "allow" : "deny", reason: `user ${approved ? "approved" : "declined"}: ${result.reason}` });
			return approved ? undefined : { block: true, reason: `${label} (declined by the user)` };
		}
		return { block: true, reason: `${label}. This needs the user's approval; draft the command for them instead of retrying.` };
	});
}
