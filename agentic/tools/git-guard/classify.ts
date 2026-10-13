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
const PUBLICATION_SUBCOMMANDS = new Set(["push", "pull", "merge", "rebase", "cherry-pick", "revert", "am", "apply", "tag", "send-pack", "http-push"]);
const SUBTREE_PUBLICATION = new Set(["push", "pull", "merge"]);
// git subtree options, which may come before its action, that take the next word as their value.
const SUBTREE_VALUED = new Set(["-P", "--prefix", "-m", "--message", "-b", "--branch", "--annotate", "--onto"]);

/** Index of the first word that is not an option or an option's value; `--opt=value` carries its own value. */
function skipOptions(args: string[], valued: Set<string>): number {
	let i = 0;
	while (i < args.length && args[i]!.startsWith("-") && args[i] !== "-") i += valued.has(args[i]!) ? 2 : 1;
	return i;
}
// `git tag` options: those that make it list or verify tags, those that create or delete one, and
// those that take the next word as their value.
const TAG_LISTS = new Set(["-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "-v", "--verify"]);
// Options that only change how a listing looks (-i is --ignore-case): neither a listing mode nor a creation.
const TAG_WRITES = new Set(["-a", "--annotate", "-s", "--sign", "-f", "--force", "-d", "--delete", "-e", "--edit", "-m", "--message", "-F", "--file", "-u", "--local-user", "--create-reflog", "--trailer", "--cleanup"]);
// --color takes only an attached =value, never the next word.
const TAG_VALUED = new Set(["-m", "--message", "-F", "--file", "-u", "--local-user", "--cleanup", "--trailer", "--sort", "--format", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged"]);
// Short tag options that select a listing mode.
const TAG_LIST_SHORT = /^-(l|v|n\d*)$/;

// git's options before the subcommand that take the next word as their value.
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
// Short options that take a value for the subcommands whose -n means --no-verify, so a cluster ends at
// them: in commit -nm the n is a flag, in -mn it is the message.
const NO_VERIFY_SHORT_VALUED: Record<string, Set<string>> = { commit: new Set(["m", "F", "c", "C", "t", "S", "u"]), am: new Set(["C", "p", "S"]) };
// `git config` options that take the next word as their value, and those that only read or remove.
const CONFIG_VALUED = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--url"]);
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--unset", "--unset-all", "--get-color", "--get-colorbool"]);
const CONFIG_READ_ACTIONS = new Set(["get", "list"]);
const CONFIG_UNSETS = new Set(["--unset", "--unset-all"]);
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

/** True when a config key decides which hooks run: core.hooksPath, or any hook.* key (git 2.54 and later config-based hooks). */
function isHookKey(key: string): boolean {
	const lower = key.toLowerCase();
	return lower === HOOKS_PATH || lower.startsWith("hook.");
}

/** True when a GIT_CONFIG_* assignment carries a hook key: GIT_CONFIG_KEY_<n>=hook.x, or GIT_CONFIG_PARAMETERS naming one. */
function assignsHookKey(assignment: string): boolean {
	if (!assignment.startsWith("GIT_CONFIG")) return false;
	const value = assignment.slice(assignment.indexOf("=") + 1);
	return /hookspath/i.test(value) || /(^|['"\s])hook\./i.test(value);
}

/**
 * True when a `git config` call writes a hook key. Reading one passes; setting, unsetting, or removing
 * or renaming its section writes it.
 */
function writesHookKey(args: string[]): boolean {
	const positional: string[] = [];
	let reads = false;
	let unsets = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (CONFIG_READS.has(arg)) reads = true;
		if (CONFIG_UNSETS.has(arg)) unsets = true;
		if (CONFIG_VALUED.has(arg)) i++;
		else if (!arg.startsWith("-")) positional.push(arg);
	}
	if (positional[0] === "unset") unsets = true;
	// git 2.46+ subcommands that write: set, unset (above), remove-section, rename-section.
	const sectionWrite = positional[0] === "remove-section" || positional[0] === "rename-section";
	const keyAt = positional.findIndex(isHookKey);
	if (keyAt === -1) return false;
	if (sectionWrite) return true;
	// Unsetting a hook key writes too: in a husky repository, unsetting core.hooksPath turns its hooks off.
	if (unsets) return true;
	if (reads || CONFIG_READ_ACTIONS.has(positional[0] ?? "")) return false;
	// `git config <key>` alone reads it; a value after the key, or a section command, writes it.
	return keyAt + 1 < positional.length || positional[0] === "set" || args.some((arg) => /^--(add|replace-all|remove-section|rename-section)$/.test(arg));
}

/** True when a short-option cluster holds -n (--no-verify) before any option that takes a value. */
function clusterHasNoVerify(arg: string, valued: Set<string>): boolean {
	if (!/^-[A-Za-z0-9]/.test(arg)) return false;
	for (const letter of arg.slice(1)) {
		if (letter === "n") return true;
		if (valued.has(letter)) return false;
	}
	return false;
}

/** How an invocation skips git hooks: a flag, a hook-key override for one command, a config write, or a hook manager's skip variable. */
type HookSkip = "flag" | "override" | "config-write" | "skip-variable";

// Variables hook managers read to skip hooks: husky, pre-commit, lefthook, overcommit.
const SKIP_VARIABLES = new Set(["HUSKY", "HUSKY_SKIP_HOOKS", "SKIP", "PRE_COMMIT_ALLOW_NO_CONFIG", "LEFTHOOK", "LEFTHOOK_EXCLUDE", "OVERCOMMIT_DISABLE"]);
const EXPORTERS = new Set(["export", "declare", "typeset", "local", "readonly"]);

/**
 * True when a command sets a hook manager's skip variable: in a git command's environment (its own
 * assignments, or those of a program the reader followed into, such as `HUSKY=0 sh -c 'git ...'`), as a
 * standalone assignment, through export and its kin, or with PowerShell's `$env:NAME = ...`.
 */
function skipVariablesSet(calls: Invocation[]): boolean {
	const named = (assignment: string) => SKIP_VARIABLES.has(assignment.slice(0, assignment.indexOf("=")));
	return calls.some((call) => {
		const name = programName(call.program);
		if (name === "git" || name === "") return call.assignments.some(named);
		return EXPORTERS.has(name) && call.args.some((arg) => arg.includes("=") && named(arg));
	});
}

function invocationHookSkip(invocation: Invocation): HookSkip | undefined {
	if (invocation.assignments.some(assignsHookKey)) return "override";
	if (programName(invocation.program) !== "git") return undefined;
	const call = gitCall(invocation);
	if (call.configKeys.some(isHookKey)) return "override";
	// Any prefix git accepts for --no-verify, before a `--` that starts pathspecs, on a subcommand that runs hooks.
	const options = call.args.indexOf("--") === -1 ? call.args : call.args.slice(0, call.args.indexOf("--"));
	if (call.subcommand !== undefined && HOOK_SUBCOMMANDS.has(call.subcommand) && options.some((arg) => arg.length >= "--no-ve".length && "--no-verify".startsWith(arg))) return "flag";
	const shortValued = call.subcommand === undefined ? undefined : NO_VERIFY_SHORT_VALUED[call.subcommand];
	if (shortValued && options.some((arg) => clusterHasNoVerify(arg, shortValued))) return "flag";
	if (call.subcommand === "config" && writesHookKey(call.args)) return "config-write";
	return undefined;
}

/**
 * True when `git tag` with these arguments only lists or verifies tags: no option that creates or
 * deletes one, and either a listing option or no tag name. Option values (-m <msg>) are values, not options.
 */
export function tagReads(args: string[]): boolean {
	let lists = false;
	let names = 0;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const option = arg.split("=")[0]!;
		if (arg === "--") {
			names += args.length - i - 1;
			break;
		}
		if (TAG_WRITES.has(option)) return false;
		if (TAG_LISTS.has(option) || TAG_LIST_SHORT.test(arg)) lists = true;
		else if (/^-[A-Za-z]{2,}$/.test(arg) && !/^-n\d+$/.test(arg)) {
			// A cluster creates a tag if any letter does (-am, -sm); otherwise it only lists.
			if ([...arg.slice(1)].some((letter) => TAG_WRITES.has(`-${letter}`))) return false;
			lists ||= [...arg.slice(1)].some((letter) => TAG_LISTS.has(`-${letter}`));
		} else if (!arg.startsWith("-")) names++;
		if (TAG_VALUED.has(arg)) i++;
	}
	return lists || names === 0;
}

/** The publication or integration command one invocation runs (`git push`, `git subtree push`, `gh pr merge`), if any. */
function invocationPublication(invocation: Invocation): string | undefined {
	const name = programName(invocation.program);
	if (name === "git") {
		const { subcommand, args } = gitCall(invocation);
		if (subcommand === undefined) return undefined;
		if (subcommand === "subtree") {
			const action = args[skipOptions(args, SUBTREE_VALUED)];
			return action !== undefined && SUBTREE_PUBLICATION.has(action) ? `git subtree ${action}` : undefined;
		}
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

/** The publication subcommand the text patterns find, skipping `git tag` forms that only list (its words read up to the next separator). */
function patternPublication(command: string): string | undefined {
	for (const match of command.matchAll(PUBLICATION)) {
		const subcommand = match[1]!;
		if (subcommand === "tag") {
			const rest = command.slice(match.index! + match[0].length).split(/[;&|\n)]/)[0]!;
			const words = rest.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ""));
			if (tagReads(words)) continue;
		}
		return `git ${subcommand}`;
	}
	return undefined;
}

/**
 * Throws Unreadable when a git or gh invocation's subcommand word, or any option word, holds an
 * unquoted glob or brace pattern, which the shell would expand into words the guard cannot see.
 * Pathspecs and other operands may hold patterns.
 */
function checkPatterns(invocation: Invocation): void {
	const name = programName(invocation.program);
	if (name !== "git" && name !== "gh") return;
	const { args, patterned } = invocation;
	// git's subcommand follows its global options; gh's command is its first operand and, except for
	// `gh api <path>`, its second.
	const commandWords = new Set<number>();
	if (name === "git") commandWords.add(args.length - gitCall(invocation).args.length - 1);
	else {
		const operands = args.flatMap((arg, i) => (arg.startsWith("-") ? [] : [i]));
		operands.slice(0, args[operands[0] ?? -1] === "api" ? 1 : 2).forEach((i) => commandWords.add(i));
	}
	args.forEach((arg, i) => {
		// An option's attached value (--jq=.[0]) may hold a pattern; its name may not.
		const isOption = arg.startsWith("-") && !arg.includes("=");
		if (patterned[i] && (isOption || commandWords.has(i))) throw new Unreadable(`its ${name} ${isOption ? "option" : "subcommand"} word ${arg} holds an unquoted glob or brace pattern`);
	});
}

/** What each reader finds in a command. */
type Findings = { reader: { skip: HookSkip | undefined; publication: string | undefined }; pattern: { skip: boolean; publication: string | undefined } };

/** Reads the command with both readers. Throws Unreadable when the command reader cannot read it. */
function findings(command: string, dialect: Dialect): Findings {
	const calls = invocations(command, dialect);
	for (const call of calls) checkPatterns(call);
	const runsGit = calls.some((call) => programName(call.program) === "git");
	const skip = calls.map(invocationHookSkip).find((found) => found !== undefined) ?? (runsGit && skipVariablesSet(calls) ? "skip-variable" : undefined);
	return {
		reader: { skip, publication: calls.map(invocationPublication).find((found) => found !== undefined) },
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
			return "git guard blocked skipping git hooks (--no-verify, commit or am -n, or a core.hooksPath or hook.* override): commit and push with hooks running, and fix what a hook reports instead of skipping it";
		case "skip-variable":
			return "git guard blocked a hook manager's skip variable (HUSKY, SKIP, LEFTHOOK, and the like) on a git command: let the hooks run, and fix what they report instead of skipping them";
		case "config-write":
			return "git guard blocked changing core.hooksPath or a hook.* key with git config, because it can switch hooks off: ask the user to set it if the repository needs its own hooks";
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
