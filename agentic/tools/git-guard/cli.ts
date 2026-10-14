#!/usr/bin/env bun
// Claude Code's PreToolUse hook for the tools that run a shell command (SHELL_TOOLS): applies the shared
// git policy (classify.ts) to the command in the event on stdin. It denies with Claude Code's JSON decision and exits 0, and allows by
// printing nothing. Claude Code treats a hook that exits other than 0 or 2 as a non-blocking error and
// runs the tool anyway, so every failure here, including an event it cannot read, becomes a deny.
import { blockReason, type Actor } from "./classify.ts";

/**
 * Claude Code 2.1.296's tools that run their tool_input.command in a shell (Bash and Monitor in bash,
 * PowerShell in PowerShell; the patterns read both alike). Found by listing the tools the binary marks
 * enablesCodeExecution and keeping those whose input holds a command (the others run JavaScript,
 * schedule prompts, or manage runners). Monitor takes either a command or a WebSocket (ws); only the
 * command form runs a shell.
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "Monitor", "PowerShell"]);

const USAGE = `Usage: git-guard --claude-hook

Claude Code PreToolUse hook for the tools that run a shell command (${[...SHELL_TOOLS].join(", ")}).
Reads the event JSON on stdin and matches the command text; git and gh match by name or absolute path,
at the start of a line or after ;, &, or |, past assignments that prefix them on that line
(GIT_EDITOR=true git commit, X=$(date +%s) git push). It reads a value made, on one line, of quoted
strings, unquoted characters other than parentheses, a $(...) holding no parenthesis, a \${...} holding
no brace, a backquoted command, and backslash escapes of anything but ;, &, or |. git after another
value (a nested substitution, a value spanning lines) is not seen.
It denies, in every session:
  - --no-verify after git on its line, or on a later line that a quoted string or a line-ending
    backslash carries the command onto;
  - -n on git commit or git am, alone or after short flags that take no value (-an, -nm);
  - a hook manager's skip variable (HUSKY, SKIP, LEFTHOOK, and the like) assigned on a line that runs
    git, or on a line of only assignments just before one that starts git;
  - core.hooksPath or a hook.* key set or unset with git -c, --config-env, or git config.
Inside a subagent (the event carries agent_id), unless its agent_type is autopilot-owner, it also denies a
line (or a command after ;, &, or |) starting git push, pull, merge, rebase, cherry-pick, revert, am,
apply, or tag (except listing), optionally after git -C <path>, or gh pr merge.
The main session may publish. An event it cannot read is denied. Exit 0 except for a usage error (2).
`;

/** Claude Code's events are a few kilobytes; anything near this is not an event. */
const STDIN_LIMIT_BYTES = 8 * 1024 * 1024;

type Event = { tool: string; command: string | undefined; actor: Actor };

class Malformed extends Error {}

function optionalString(event: Record<string, unknown>, field: string): string | undefined {
	const value = event[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Malformed(`${field} is not a string`);
	return value;
}

/** Reads the fields the guard needs; throws Malformed for anything it cannot trust. */
export function parseEvent(text: string): Event {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Malformed("stdin is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Malformed("the event is not a JSON object");
	const event = parsed as Record<string, unknown>;
	const tool = optionalString(event, "tool_name");
	if (tool === undefined) throw new Malformed("tool_name is missing");
	// agent_id marks a subagent (observed) or an in-process teammate (documented, not observed here);
	// agent_type alone also appears on a main session started with --agent, so it never marks a child.
	const agentId = optionalString(event, "agent_id");
	const actor: Actor = agentId === undefined ? { kind: "main" } : { kind: "child", role: optionalString(event, "agent_type") };
	if (!SHELL_TOOLS.has(tool)) return { tool, command: undefined, actor };
	const input = event.tool_input;
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Malformed("tool_input is missing");
	const fields = input as Record<string, unknown>;
	if (tool === "Monitor" && fields.command === undefined && typeof fields.ws === "object" && fields.ws !== null) return { tool, command: undefined, actor };
	if (typeof fields.command !== "string") throw new Malformed("tool_input.command is not a string");
	return { tool, command: fields.command, actor };
}

function deny(reason: string): string {
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

/** The hook's stdout for an event: a deny decision, or empty to let the permission flow continue. */
export function decide(text: string): string {
	let event: Event;
	try {
		event = parseEvent(text);
	} catch (error) {
		if (!(error instanceof Malformed)) throw error;
		return deny(`git guard could not read the PreToolUse event (${error.message}), so it refused the command. Check the hook wiring in settings.json`);
	}
	// A tool that runs no shell command (or a Monitor watching a WebSocket) is outside the git policy.
	if (event.command === undefined) return "";
	const reason = blockReason(event.command, event.actor);
	return reason === undefined ? "" : deny(reason);
}

async function readStdin(): Promise<string> {
	const bytes = await Bun.stdin.bytes();
	if (bytes.length > STDIN_LIMIT_BYTES) throw new Malformed(`stdin is over ${STDIN_LIMIT_BYTES} bytes`);
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function main(args: string[]): Promise<number> {
	if (args.length !== 1 || args[0] !== "--claude-hook") {
		const help = args[0] === "--help" || args[0] === "-h";
		(help ? console.log : console.error)(USAGE);
		return help ? 0 : 2;
	}
	let output: string;
	try {
		output = decide(await readStdin());
	} catch (error) {
		output = deny(`git guard failed (${(error as Error).message}), so it refused the command. Run the hook by hand with this event to see why`);
	}
	if (output) console.log(output);
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
