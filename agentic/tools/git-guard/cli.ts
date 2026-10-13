#!/usr/bin/env bun
// Claude Code's PreToolUse hook for the tools that run a shell command (SHELL_TOOLS): applies the shared
// git policy (classify.ts) to the command in the event on stdin. It denies with Claude Code's JSON decision and exits 0, and allows by
// printing nothing. Claude Code treats a hook that exits other than 0 or 2 as a non-blocking error and
// runs the tool anyway, so every failure here, including an event it cannot read, becomes a deny.
import { blockReason, type Actor, type Dialect } from "./classify.ts";

/**
 * Claude Code 2.1.296's tools that run their tool_input.command in a shell, and the shell each uses.
 * Found by listing the tools the binary marks enablesCodeExecution and keeping those whose input holds
 * a command (the others run JavaScript, schedule prompts, or manage runners). Monitor takes either a
 * command or a WebSocket (ws); only the command form runs a shell.
 */
export const SHELL_TOOLS: ReadonlyMap<string, Dialect> = new Map([
	["Bash", "posix"],
	["Monitor", "posix"],
	["PowerShell", "powershell"],
]);

const USAGE = `Usage: git-guard --claude-hook

Claude Code PreToolUse hook for the tools that run a shell command (${[...SHELL_TOOLS.keys()].join(", ")}).
Reads the event JSON on stdin and denies:
  - skipping git hooks, in every session: --no-verify, git commit -n or git am -n, an override or
    git config change of core.hooksPath or a hook.* key, or a hook manager's skip variable (HUSKY, SKIP,
    LEFTHOOK, ...) on a git command;
  - git push, pull, merge, rebase, cherry-pick, revert, am, apply, tag (except listing), send-pack, and
    http-push, git subtree push, pull, and merge, and gh pr merge, inside a subagent (the event carries
    agent_id), unless its agent_type is autopilot-owner.
The main session may publish. An event or command it cannot read is denied. Exit 0 except for a usage
error (2).
`;

/** Claude Code's events are a few kilobytes; anything near this is not an event. */
const STDIN_LIMIT_BYTES = 8 * 1024 * 1024;

type Event = { tool: string; command: string | undefined; dialect: Dialect; actor: Actor };

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
	const dialect = SHELL_TOOLS.get(tool);
	if (dialect === undefined) return { tool, command: undefined, dialect: "posix", actor };
	const input = event.tool_input;
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Malformed("tool_input is missing");
	const fields = input as Record<string, unknown>;
	if (tool === "Monitor" && fields.command === undefined && typeof fields.ws === "object" && fields.ws !== null) return { tool, command: undefined, dialect, actor };
	if (typeof fields.command !== "string") throw new Malformed("tool_input.command is not a string");
	return { tool, command: fields.command, dialect, actor };
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
	const reason = blockReason(event.command, event.actor, event.dialect);
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
