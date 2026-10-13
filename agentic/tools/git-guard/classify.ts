// The git command policy both runtimes enforce on a shell command before it runs: Pi's git-interceptor
// extension and Claude Code's PreToolUse hook (cli.ts). Each runtime decides who is acting; this module
// decides what that actor may run. It reads the command text only and never runs anything.
//
// Two readers find what a command does. The original text patterns stay, so nothing they refused now
// passes, and shell.ts splits the line into the commands it would run, which catches the forms the
// patterns miss (absolute paths, wrappers, git options before the subcommand, short flags, config).
import { invocations, programName, TooDeep, type Dialect, type Invocation } from "./shell.ts";

export type { Dialect } from "./shell.ts";

/** Who issued the command. The coordinating session publishes; a child publishes only as an autopilot-full owner. */
export type Actor = { kind: "main" } | { kind: "child"; role: string | undefined };

/** The one child role that carries its own pull request through the merge (babysit-and-ship). */
export const PUBLISHING_CHILD_ROLE = "autopilot-owner";

const NO_VERIFY = /(^|[;&|\n]\s*)git\s+[^\n]*--no-verify\b/;
// A git invocation (at the start or after ;, &, |, or a newline, past any -C <path> options) that
// publishes or integrates history.
const PUBLICATION = /(?:^|[;&|\n]\s*)git(?:\s+-C\s+(?:'[^']*'|"[^"]*"|\S+))*\s+(push|pull|merge|rebase|cherry-pick|revert|am|apply|tag)\b/;
const PUBLICATION_SUBCOMMANDS = new Set(["push", "pull", "merge", "rebase", "cherry-pick", "revert", "am", "apply", "tag"]);

// git's options before the subcommand that take the next word as their value.
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source"]);
// `git commit` short options that take a value, so a cluster ends at them: in -nm the n is a flag, in -mn it is the message.
const COMMIT_VALUED_SHORT = new Set(["m", "F", "c", "C", "t", "S", "u"]);
// `git config` options that take the next word as their value, and those that only read or remove.
const CONFIG_VALUED = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--url"]);
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--unset", "--unset-all", "--get-color", "--get-colorbool"]);
const CONFIG_READ_ACTIONS = new Set(["get", "list", "unset"]);
const HOOKS_PATH = "core.hookspath";
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

/** True when one invocation skips git hooks: --no-verify (or a prefix of it), commit -n, or a core.hooksPath override. */
function invocationSkipsHooks(invocation: Invocation): boolean {
	if (invocation.assignments.some((assignment) => /^GIT_CONFIG/.test(assignment) && /hookspath/i.test(assignment))) return true;
	if (programName(invocation.program) !== "git") return false;
	const call = gitCall(invocation);
	if (call.configKeys.includes(HOOKS_PATH)) return true;
	if (call.args.some((arg) => arg.length >= "--no-ve".length && "--no-verify".startsWith(arg))) return true;
	if (call.subcommand === "commit" && call.args.some(clusterHasNoVerify)) return true;
	return call.subcommand === "config" && setsHooksPath(call.args);
}

/** The publication or integration command one invocation runs (`git push`, `gh pr merge`), if any. */
function invocationPublication(invocation: Invocation): string | undefined {
	const name = programName(invocation.program);
	if (name === "git") {
		const { subcommand } = gitCall(invocation);
		return subcommand !== undefined && PUBLICATION_SUBCOMMANDS.has(subcommand) ? `git ${subcommand}` : undefined;
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

/** True when the command skips git hooks anywhere in it. Throws TooDeep for a command nested past the limit. */
export function skipsHooks(command: string, dialect: Dialect = "posix"): boolean {
	return NO_VERIFY.test(command) || invocations(command, dialect).some(invocationSkipsHooks);
}

/** The first publication or integration command in the command (`git push`, `gh pr merge`), if any. Throws TooDeep. */
export function publicationCommand(command: string, dialect: Dialect = "posix"): string | undefined {
	const matched = PUBLICATION.exec(command)?.[1];
	if (matched !== undefined) return `git ${matched}`;
	for (const invocation of invocations(command, dialect)) {
		const publication = invocationPublication(invocation);
		if (publication !== undefined) return publication;
	}
	return undefined;
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
 * A command nested too deeply to check is refused for every actor.
 */
export function blockReason(command: string, actor: Actor, dialect: Dialect = "posix"): string | undefined {
	try {
		if (skipsHooks(command, dialect)) {
			return "git guard blocked skipping git hooks (--no-verify, commit -n, or a core.hooksPath override): commit and push with hooks running, and fix what a hook reports instead of skipping it";
		}
		const publication = mayPublish(actor) ? undefined : publicationCommand(command, dialect);
		if (publication === undefined) return undefined;
		return `git guard blocked child publication/integration command: ${publication}. Only the coordinating session or an ${PUBLISHING_CHILD_ROLE} publishes or integrates; commit locally and report the branch and head SHA to your parent instead`;
	} catch (error) {
		if (!(error instanceof TooDeep)) throw error;
		return `git guard could not check this command: ${error.message}. Split it into simpler commands`;
	}
}
