#!/usr/bin/env bun
// Claude Code's PreToolUse hook for the tools that edit files (EDIT_TOOLS). code-design is a skill the
// agent loads only when it judges an edit to be code, and a comment-only or one-line edit can look as if
// it were not, so the first edit of a source file in each session, and in each subagent, gets a reminder
// to load it. The hook only adds context: it never denies, and a failure prints nothing so the edit goes
// ahead.
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/** Claude Code's tools that write a file, and the input field naming it. */
export const EDIT_TOOLS: ReadonlyMap<string, string> = new Map([
	["Edit", "file_path"],
	["MultiEdit", "file_path"],
	["Write", "file_path"],
	["NotebookEdit", "notebook_path"],
]);

/** Extensions of source code, where code-design's rules apply; prose and configuration files are not listed. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
	".bash", ".c", ".cc", ".cjs", ".clj", ".cljs", ".cpp", ".cs", ".css", ".cts", ".dart", ".ex", ".exs",
	".fish", ".gd", ".gleam", ".glsl", ".go", ".h", ".hlsl", ".hpp", ".hs", ".ipynb", ".java", ".js", ".jsx",
	".kt", ".lua", ".m", ".mjs", ".ml", ".mm", ".mts", ".odin", ".php", ".ps1", ".py", ".rb", ".rs", ".scala",
	".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue", ".wgsl", ".zig", ".zsh",
]);

export const REMINDER =
	"If this session has not loaded the code-design skill, load it now and check this edit against it: its rules apply to every source edit, comment-only and one-line edits included. This reminder appears once per session and per subagent.";

const USAGE = `Usage: skill-reminder --claude-hook

Claude Code PreToolUse hook for ${[...EDIT_TOOLS.keys()].join(", ")}. Reads the event JSON on stdin. The
first edit of a source file (${SOURCE_EXTENSIONS.size} extensions, such as .ts and .py) in a session, and in
each subagent, gets a reminder to load the code-design skill, as additionalContext. It never denies.
Markers live in $XDG_STATE_HOME/agentic/skill-reminder/. Exit 0; a usage error exits 1, which Claude Code
treats as a non-blocking error, so a miswired hook never stops an edit.
`;

/** A Write event carries the whole file; one larger than this gets no reminder. */
const STDIN_LIMIT_BYTES = 8 * 1024 * 1024;

type Edit = { session: string; agent: string; path: string };

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
	return { session: fields.session_id, agent, path };
}

function markerName(text: string): string {
	return text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "unknown";
}

/**
 * Whether this edit is the session's (or subagent's) first source edit. The marker is created with the
 * exclusive flag, so of two concurrent edits exactly one sees true.
 */
export function firstSourceEdit(edit: Edit, env: Record<string, string | undefined>): boolean {
	if (!SOURCE_EXTENSIONS.has(extname(edit.path).toLowerCase())) return false;
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
	if (edit === undefined || !firstSourceEdit(edit, env)) return "";
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
