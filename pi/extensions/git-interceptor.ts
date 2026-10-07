import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function command(input: unknown): string {
	return typeof (input as any)?.command === "string" ? (input as any).command : "";
}

function blocksNoVerify(cmd: string): boolean {
	return /(^|[;&|\n]\s*)git\s+[^\n]*--no-verify\b/.test(cmd);
}

function isNativeChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "true";
}

// An autopilot-full owner carries its own pull request through the merge (babysit-and-ship), so
// that one role may publish; every other child may not.
function isAutopilotOwner(): boolean {
	return process.env.PI_SUBAGENT_CHILD_AGENT === "autopilot-owner";
}

function childPublicationCommand(cmd: string): string | null {
	if (!isNativeChild() || isAutopilotOwner()) return null;
	const match = cmd.match(/(?:^|[;&|\n]\s*)git(?:\s+-C\s+(?:'[^']*'|"[^"]*"|\S+))*\s+(push|pull|merge|rebase|cherry-pick|revert|am|apply|tag)\b/);
	return match?.[1] ?? null;
}

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
		if (blocksNoVerify(cmd)) return { block: true, reason: "git-interceptor blocked --no-verify" };
		const publicationCommand = childPublicationCommand(cmd);
		if (publicationCommand) return { block: true, reason: `git-interceptor blocked child publication/integration command: git ${publicationCommand}` };
		if (preventsEditorHang(cmd)) return { block: true, reason: "git-interceptor blocked interactive git editor; pass -m/--no-edit or set GIT_EDITOR=true" };
	});
}
