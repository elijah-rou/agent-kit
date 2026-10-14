#!/usr/bin/env bun
// Claude Code's PreToolUse hook for the tools that edit files (EDIT_TOOLS). code-design is a skill the
// agent loads only when it judges an edit to be code, and a comment-only or one-line edit can look as if
// it were not, so the first file edit in each session, and in each subagent, gets a reminder to load it.
// Any file counts: whether a file is code is left to the agent, since no list of extensions fits every
// project. The hook only adds context: it never denies, and a failure prints nothing so the edit goes
// ahead.
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's tools that write a file, and the input field naming it. */
export const EDIT_TOOLS: ReadonlyMap<string, string> = new Map([
	["Edit", "file_path"],
	["MultiEdit", "file_path"],
	["Write", "file_path"],
	["NotebookEdit", "notebook_path"],
]);

export const REMINDER =
	"If this file is code and this session has not loaded the code-design skill, load it now and check this edit against it: its rules apply to every code edit, comment-only and one-line edits included. This reminder appears once per session and per subagent, on its first file edit.";

const USAGE = `Usage: skill-reminder --claude-hook

Claude Code PreToolUse hook for ${[...EDIT_TOOLS.keys()].join(", ")}. Reads the event JSON on stdin. The
first file edit in a session, and in each subagent, gets a reminder to load the code-design skill if the
file is code, as additionalContext. It never denies.
Markers live in $XDG_STATE_HOME/agentic/skill-reminder/. Exit 0; a usage error exits 1, which Claude Code
treats as a non-blocking error, so a miswired hook never stops an edit.
`;

/** A Write event carries the whole file; one larger than this gets no reminder. */
const STDIN_LIMIT_BYTES = 8 * 1024 * 1024;

type Edit = { session: string; agent: string };

/** The fields the hook needs, or undefined for an event that is not a file edit it can read. */
export function parseEdit(text: string): Edit | undefined {
	let event: unknown;
	try {
		event = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof event !== "object" || event === null || Array.isArray(event)) return undefined;
	const fields = event as Record<string, unknown>;
	const field = typeof fields.tool_name === "string" ? EDIT_TOOLS.get(fields.tool_name) : undefined;
	const input = fields.tool_input;
	if (field === undefined || typeof input !== "object" || input === null) return undefined;
	const path = (input as Record<string, unknown>)[field];
	if (typeof path !== "string" || typeof fields.session_id !== "string") return undefined;
	const agent = typeof fields.agent_id === "string" ? fields.agent_id : "main";
	return { session: fields.session_id, agent };
}

function markerName(text: string): string {
	return text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "unknown";
}

/**
 * Whether this edit is the session's (or subagent's) first file edit. The marker is created with the
 * exclusive flag, so of two concurrent edits exactly one sees true.
 */
export function firstEdit(edit: Edit, env: Record<string, string | undefined>): boolean {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	const dir = join(state, "agentic", "skill-reminder", markerName(edit.session));
	mkdirSync(dir, { recursive: true });
	try {
		closeSync(openSync(join(dir, markerName(edit.agent)), "wx"));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/** The hook's stdout for an event: the reminder as additionalContext, or empty. */
export function respond(text: string, env: Record<string, string | undefined>): string {
	const edit = parseEdit(text);
	if (edit === undefined || !firstEdit(edit, env)) return "";
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: REMINDER } });
}

async function main(args: string[]): Promise<number> {
	if (args.length !== 1 || args[0] !== "--claude-hook") {
		const help = args[0] === "--help" || args[0] === "-h";
		(help ? console.log : console.error)(USAGE);
		return help ? 0 : 1;
	}
	try {
		const bytes = await Bun.stdin.bytes();
		const output = bytes.length > STDIN_LIMIT_BYTES ? "" : respond(new TextDecoder().decode(bytes), process.env);
		if (output) console.log(output);
	} catch {
		// A reminder is optional; a failure must never stop the edit.
	}
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
