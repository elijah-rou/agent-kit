import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { blockReason, type Actor } from "../../agentic/tools/git-guard/classify.ts";

function command(input: unknown): string {
	return typeof (input as any)?.command === "string" ? (input as any).command : "";
}

// Pi marks a native child in its environment and names its role; the shared policy decides what that
// actor may run (Claude Code's PreToolUse hook applies the same policy from the event's agent fields).
function actor(): Actor {
	const child = process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "true";
	return child ? { kind: "child", role: process.env.PI_SUBAGENT_CHILD_AGENT } : { kind: "main" };
}

// Pi's bash tool has no editor to answer, so an editor-opening git command would hang. Claude Code's
// Bash tool sets GIT_EDITOR=true, so its hook does not need this rule.
function preventsEditorHang(cmd: string): boolean {
	if (!/(^|[;&|\n]\s*)git\s+/.test(cmd)) return false;
	if (/\b(?:GIT_EDITOR|VISUAL|EDITOR)=/.test(cmd)) return false;
	if (/(?:^|\s)(?:-m|-F|--message|--file|--no-edit|--dry-run|--porcelain)(?:\s|=|$)/.test(cmd)) return false;
	return /\bgit\s+(?:commit|rebase\s+-i|tag\s+-a|tag\s+--annotate)\b/.test(cmd);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", event => {
		if (event.toolName !== "bash") return;
		const cmd = command(event.input);
		const reason = blockReason(cmd, actor());
		if (reason) return { block: true, reason: `git-interceptor: ${reason}` };
		if (preventsEditorHang(cmd)) return { block: true, reason: "git-interceptor blocked interactive git editor; pass -m/--no-edit or set GIT_EDITOR=true" };
	});
}
