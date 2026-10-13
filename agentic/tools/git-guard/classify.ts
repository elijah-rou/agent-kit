// The git command policy both runtimes enforce on a shell command before it runs: Pi's git-interceptor
// extension and Claude Code's PreToolUse hook (cli.ts). Each runtime decides who is acting; this module
// decides what that actor may run. It reads the command text only and never runs anything.
//
// Two readers decide together, and either one refusing refuses the command. The text patterns (kept
// from Pi's original interceptor, narrowed only where they matched other git commands) catch a git
// command at the start of any line, even inside a quoted message; shell.ts reads the commands the line
// would run, which catches what the patterns miss (absolute paths, wrappers, options before the
// subcommand, redirections, here documents, short flags, config). When only the patterns refuse, the
// reason says the match may be a mention and how to rephrase it.
import { invocations, programName, Unreadable, type Dialect, type Invocation } from "./shell.ts";

export type { Dialect } from "./shell.ts";

/** Who issued the command. The coordinating session publishes; a child publishes only as an autopilot-full owner. */
export type Actor = { kind: "main" } | { kind: "child"; role: string | undefined };

/** The one child role that carries its own pull request through the merge (babysit-and-ship). */
export const PUBLISHING_CHILD_ROLE = "autopilot-owner";

// --no-verify after a git at the start of a line, but not git's own --no-verify-signatures.
const NO_VERIFY = /(^|[;&|\n]\s*)git\s+[^\n]*--no-verify(?![\w-])/;
// A git invocation (at the start or after ;, &, |, or a newline, past any -C <path> options) that
// publishes or integrates history; merge-base and other hyphenated subcommands are not these.
const PUBLICATION = /(?:^|[;&|\n]\s*)git(?:\s+-C\s+(?:'[^']*'|"[^"]*"|\S+))*\s+(push|pull|merge|rebase|cherry-pick|revert|am|apply|tag)(?![\w-])/g;
// The rest of a `git tag` command that only lists or verifies tags: nothing, or a listing option.
const TAG_READ_TEXT = /^[ \t]*(?:$|[;&|\n)]|[^;&|\n]*?(?:^|\s)(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify)(?=[\s=;&|)]|$))/;
const PUBLICATION_SUBCOMMANDS = new Set(["push", "pull", "merge", "rebase", "cherry-pick", "revert", "am", "apply", "tag"]);
const SUBTREE_PUBLICATION = new Set(["push", "pull", "merge"]);
// `git tag` options that make it list or verify tags instead of creating or deleting one.
const TAG_READS = new Set(["-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "-v", "--verify"]);

// git's options before the subcommand that take the next word as their value.
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
// `git commit` short options that take a value, so a cluster ends at them: in -nm the n is a flag, in -mn it is the message.
const COMMIT_VALUED_SHORT = new Set(["m", "F", "c", "C", "t", "S", "u"]);
// `git config` options that take the next word as their value, and those that only read or remove.
const CONFIG_VALUED = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--url"]);
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--unset", "--unset-all", "--get-color", "--get-colorbool"]);
const CONFIG_READ_ACTIONS = new Set(["get", "list", "unset"]);
const HOOKS_PATH = "core.hookspath";
// git subcommands that run hooks and take --no-verify to skip them.
const HOOK_SUBCOMMANDS = new Set(["commit", "merge", "pull", "push", "am", "rebase"]);
// gh's options before its command that take the next word as their value.
const GH_VALUED = new Set(["-R", "--repo", "--hostname"]);

/** A git invocation read as git reads it: its config overrides, subcommand, and the subcommand's arguments. */
type GitCall = { configKeys: string[]; subcommand: string | undefined; args: string[] };

function gitCall(invocation: Invocation): GitCall {
	const configKeys: string[] = [];
	const { args } = invocation;
	let i = 0;
	while (i < args.length && args[i]!.startsWith("-")) {
		const arg = args[i]!;
		const [option, attached] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		const value = attached ?? (GIT_VALUED.has(option) ? args[i + 1] : undefined);
		if ((option === "-c" || option === "--config-env") && value !== undefined) configKeys.push(value.split("=")[0]!.toLowerCase());
		i += attached === undefined && GIT_VALUED.has(option) ? 2 : 1;
	}
	return { configKeys, subcommand: args[i], args: args.slice(i + 1) };
}

/** True when a `git config` call writes core.hooksPath (reading or unsetting it is fine). */
function setsHooksPath(args: string[]): boolean {
	const positional: string[] = [];
	let reads = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (CONFIG_READS.has(arg)) reads = true;
		if (CONFIG_VALUED.has(arg)) i++;
		else if (!arg.startsWith("-")) positional.push(arg);
	}
	const keyAt = positional.findIndex((word) => word.toLowerCase() === HOOKS_PATH);
	if (keyAt === -1) return false;
	if (reads || CONFIG_READ_ACTIONS.has(positional[0] ?? "")) return false;
	// `git config core.hooksPath` alone reads it; a value after the key sets it.
	return keyAt + 1 < positional.length;
}

/** True when a short-option cluster for `git commit` holds -n (--no-verify) before any option that takes a value. */
function clusterHasNoVerify(arg: string): boolean {
	if (!/^-[A-Za-z]/.test(arg)) return false;
	for (const letter of arg.slice(1)) {
		if (letter === "n") return true;
		if (COMMIT_VALUED_SHORT.has(letter)) return false;
	}
	return false;
}

/** How an invocation skips git hooks: a flag, a core.hooksPath override for one command, or a config write. */
type HookSkip = "flag" | "override" | "config-write";

function invocationHookSkip(invocation: Invocation): HookSkip | undefined {
	if (invocation.assignments.some((assignment) => /^GIT_CONFIG/.test(assignment) && /hookspath/i.test(assignment))) return "override";
	if (programName(invocation.program) !== "git") return undefined;
	const call = gitCall(invocation);
	if (call.configKeys.includes(HOOKS_PATH)) return "override";
	// Any prefix git accepts for --no-verify, before a `--` that starts pathspecs, on a subcommand that runs hooks.
	const options = call.args.indexOf("--") === -1 ? call.args : call.args.slice(0, call.args.indexOf("--"));
	if (call.subcommand !== undefined && HOOK_SUBCOMMANDS.has(call.subcommand) && options.some((arg) => arg.length >= "--no-ve".length && "--no-verify".startsWith(arg))) return "flag";
	if (call.subcommand === "commit" && call.args.some(clusterHasNoVerify)) return "flag";
	if (call.subcommand === "config" && setsHooksPath(call.args)) return "config-write";
	return undefined;
}

/** True when `git tag` with these arguments lists or verifies tags: no arguments, or a listing option. */
function tagReads(args: string[]): boolean {
	return args.length === 0 || args.some((arg) => TAG_READS.has(arg.split("=")[0]!) || /^-n\d*$/.test(arg));
}

/** The publication or integration command one invocation runs (`git push`, `git subtree push`, `gh pr merge`), if any. */
function invocationPublication(invocation: Invocation): string | undefined {
	const name = programName(invocation.program);
	if (name === "git") {
		const { subcommand, args } = gitCall(invocation);
		if (subcommand === undefined) return undefined;
		if (subcommand === "subtree" && SUBTREE_PUBLICATION.has(args[0] ?? "")) return `git subtree ${args[0]}`;
		if (subcommand === "tag" && tagReads(args)) return undefined;
		return PUBLICATION_SUBCOMMANDS.has(subcommand) ? `git ${subcommand}` : undefined;
	}
	if (name === "gh") {
		const positional: string[] = [];
		for (let i = 0; i < invocation.args.length && positional.length < 2; i++) {
			const arg = invocation.args[i]!;
			if (GH_VALUED.has(arg)) i++;
			else if (!arg.startsWith("-")) positional.push(arg);
		}
		return positional[0] === "pr" && positional[1] === "merge" ? "gh pr merge" : undefined;
	}
	return undefined;
}

/** The publication subcommand the text patterns find, skipping `git tag` forms that only list. */
function patternPublication(command: string): string | undefined {
	for (const match of command.matchAll(PUBLICATION)) {
		const subcommand = match[1]!;
		if (subcommand === "tag" && TAG_READ_TEXT.test(command.slice(match.index! + match[0].length))) continue;
		return `git ${subcommand}`;
	}
	return undefined;
}

/** What each reader finds in a command. */
type Findings = { reader: { skip: HookSkip | undefined; publication: string | undefined }; pattern: { skip: boolean; publication: string | undefined } };

/** Reads the command with both readers. Throws Unreadable when the command reader cannot read it. */
function findings(command: string, dialect: Dialect): Findings {
	const calls = invocations(command, dialect);
	return {
		reader: { skip: calls.map(invocationHookSkip).find((skip) => skip !== undefined), publication: calls.map(invocationPublication).find((found) => found !== undefined) },
		pattern: { skip: NO_VERIFY.test(command), publication: patternPublication(command) },
	};
}

/** True when either reader finds the command skipping git hooks. Throws Unreadable. */
export function skipsHooks(command: string, dialect: Dialect = "posix"): boolean {
	const found = findings(command, dialect);
	return found.reader.skip !== undefined || found.pattern.skip;
}

/** The publication or integration command either reader finds (`git push`, `gh pr merge`), if any. Throws Unreadable. */
export function publicationCommand(command: string, dialect: Dialect = "posix"): string | undefined {
	const found = findings(command, dialect);
	return found.reader.publication ?? found.pattern.publication;
}

/** True when the actor may publish: the main session, or a child running as an autopilot-full owner. */
export function mayPublish(actor: Actor): boolean {
	switch (actor.kind) {
		case "main":
			return true;
		case "child":
			return actor.role === PUBLISHING_CHILD_ROLE;
	}
}

/**
 * Why the actor may not run the command, or undefined when the policy allows it. Skipping hooks is
 * refused for every actor; publication and integration are refused for every child except an owner.
 * A command the reader cannot read is refused for every actor.
 */
export function blockReason(command: string, actor: Actor, dialect: Dialect = "posix"): string | undefined {
	let found: Findings;
	try {
		found = findings(command, dialect);
	} catch (error) {
		if (!(error instanceof Unreadable)) throw error;
		return `git guard could not read this command: ${error.message}. Rewrite it so a shell can read it plainly: close every quote, substitution, and here document, keep nesting shallow, and name programs without patterns`;
	}
	const publishes = !mayPublish(actor);
	switch (found.reader.skip) {
		case "flag":
		case "override":
			return "git guard blocked skipping git hooks (--no-verify, commit -n, or a core.hooksPath override): commit and push with hooks running, and fix what a hook reports instead of skipping it";
		case "config-write":
			return "git guard blocked setting core.hooksPath with git config, because it can switch hooks off: ask the user to set it if the repository needs its own hooks directory";
		case undefined:
			break;
	}
	if (publishes && found.reader.publication !== undefined) return publicationReason(found.reader.publication);
	if (found.pattern.skip) {
		return "git guard blocked a command whose text has --no-verify after git on one line. It may only mention the flag, as in a commit message or a search: write such a message to a file with the editor tool and run git commit -F <file>, and search for the flag without its leading dashes";
	}
	if (publishes && found.pattern.publication !== undefined) {
		return `git guard blocked a command whose text starts a line with ${found.pattern.publication}, which a child may not run. It may only mention the command, as in a commit message or a search: write such a message to a file with the editor tool and run git commit -F <file>, and search without git in front`;
	}
	return undefined;
}

function publicationReason(publication: string): string {
	return `git guard blocked child publication/integration command: ${publication}. Only the coordinating session or an ${PUBLISHING_CHILD_ROLE} publishes or integrates; commit locally and report the branch and head SHA to your parent instead`;
}
