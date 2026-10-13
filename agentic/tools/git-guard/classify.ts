// The git command policy both runtimes enforce on a shell command before it runs: Pi's git-interceptor
// extension and Claude Code's PreToolUse hook (cli.ts). Each runtime decides who is acting; this module
// decides what that actor may run. It reads the command text only and never runs anything.
//
// The policy is text patterns: the two kept from Pi's original interceptor (--no-verify, and publication
// or integration), narrowed only where they matched other git commands (--no-verify-signatures,
// merge-base, and listing tags), and patterns for what a shell reader, since removed, used to find:
// git commit or am -n, a hook manager's skip variable, a core.hooksPath or hook.* override or config
// write, and gh pr merge. They find git or gh, by name or absolute path, at the start of a line or after
// ;, &, or |, so they also match a mention in a quoted message or a search, and each reason says how to
// rephrase one. --no-verify also counts on a later line that a quoted string or a line-ending backslash
// carries git's command onto. They do not read the shell otherwise: git reached another way (a wrapper,
// a substitution, a `sh -c` string) is not seen.

/** Who issued the command. The coordinating session publishes; a child publishes only as an autopilot-full owner. */
export type Actor = { kind: "main" } | { kind: "child"; role: string | undefined };

/** The one child role that carries its own pull request through the merge (babysit-and-ship). */
export const PUBLISHING_CHILD_ROLE = "autopilot-owner";

// Where a command starts: the start of the text, or after ;, &, |, or a newline and any spaces.
const START = String.raw`(?:^|[;&|\n]\s*)`;
/** A program by name or by absolute path (/usr/bin/git). */
const program = (name: string) => String.raw`(?:(?:/[^\s/;&|<>()'"]*)*/)?${name}`;
const GIT = program("git");
// git's -C <path> options, the only options the patterns skip before a subcommand. A path is a run of
// quoted and bare parts; each part starts with a different character and a bare part holds no
// whitespace, so a run of options reads one way and cannot backtrack exponentially.
const GIT_DASH_C = String.raw`(?:\s+-C\s+(?:'[^']*'|"[^"]*"|[^\s'"])+)*`;
// One word: quoted, or up to whitespace or a separator.
const WORD = String.raw`(?:'[^'\n]*'|"[^"\n]*"|[^\s;&|'"]+)`;
// An assignment's value: quoted parts and unquoted characters, read to the whole value (up to whitespace,
// a separator, or the end) so a long value cannot backtrack into many shorter ones.
const VALUE = String.raw`(?:'[^'\n]*'|"[^"\n]*"|[^\s;&|'"])*(?![^\s;&|])`;
const ASSIGNMENT = String.raw`[A-Za-z_]\w*=${VALUE}`;

// --no-verify, but not git's own --no-verify-signatures.
const NO_VERIFY_FLAG = new RegExp(String.raw`--no-verify(?![\w-])`);
// --no-verify after a git at the start of a line.
const NO_VERIFY = new RegExp(String.raw`${START}${GIT}\s+[^\n]*${NO_VERIFY_FLAG.source}`);
// A git at the start of a line, and the rest of its command: unquoted text up to a newline or a comment,
// with quoted strings and backslash escapes that may carry it onto later lines (a commit message in a
// here document, or a backslash at a line's end). Each alternative starts with a different character,
// so the text reads one way.
const GIT_COMMAND = new RegExp(String.raw`${START}${GIT}[^\S\n]((?:[^\n'"\\\s#]|[^\S\n](?!#)|(?<!\s)#|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*")*)`, "g");
// git commit's and git am's short options that take no value, and their long options that begin like a
// cluster holding n (git refuses a single-dash word of three or more letters that begins a long option's
// name or begins with no-, as in -include or -no-op, before any hook runs).
const COMMIT_SHORT_FLAGS = "qvseaipoz";
const AM_SHORT_FLAGS = "iqsukmcr3";
const COMMIT_LONG_LIKE_N = ["include", "inter-hunk-context", "interactive", "only"];
const AM_LONG_LIKE_N = ["include", "interactive"];
/** -n in a cluster of `flags` (alone, -an, -nm), unless git refuses the word as a misspelled long option. */
function shortN(flags: string, longNames: string[]): string {
	const prefixes = longNames.flatMap((name) => [...name].slice(2).map((_, i) => name.slice(0, i + 3)));
	return String.raw`\s-(?!no-|(?:${prefixes.join("|")})(?![^\s'";&|)]))[${flags}]*n`;
}
// -n (--no-verify) on git commit or git am, alone or after short options that take no value (-an), and
// before any option, which may take the rest of the cluster as its value (-nm). The search stops at ;,
// &, or | so a later command's -n (git log -n 3) is not taken for it.
const NO_VERIFY_SHORT = new RegExp(String.raw`${START}${GIT}${GIT_DASH_C}\s+(?:commit(?![\w-])[^\n;&|]*?${shortN(COMMIT_SHORT_FLAGS, COMMIT_LONG_LIKE_N)}|am(?![\w-])[^\n;&|]*?${shortN(AM_SHORT_FLAGS, AM_LONG_LIKE_N)})`);
// Variables hook managers read to skip hooks: husky, pre-commit, lefthook, overcommit.
const SKIP_VARIABLES = ["HUSKY_SKIP_HOOKS", "HUSKY", "SKIP", "PRE_COMMIT_ALLOW_NO_CONFIG", "LEFTHOOK_EXCLUDE", "LEFTHOOK", "OVERCOMMIT_DISABLE"];
// A skip variable assigned where a command starts (alone, among other assignments, or after export and
// its kin), with git run on the same line, as that command (HUSKY=0 git commit) or after a separator, or
// starting the next line when only assignments come between (export HUSKY=0, then git commit).
const SKIP_VARIABLE = new RegExp(String.raw`${START}(?:(?:export|declare|typeset|local|readonly)(?:\s+-\w+)*\s+)?(?:${ASSIGNMENT}\s+)*(?:${SKIP_VARIABLES.join("|")})=${VALUE}(?:(?:\s+${ASSIGNMENT})*\s+|[^\n]*?[;&|]\s*)${GIT}\s`);
/** One option: a `valued` option and the next word, or any other option word. The two never overlap, so a run of options reads one way and cannot backtrack exponentially. */
function option(valued: string[]): string {
	const names = valued.join("|");
	return String.raw`(?:\s+(?:${names})\s+${WORD}|\s+(?!(?:${names})(?:\s|$))-[^\s;&|]+)`;
}
/** A pattern for `text` that ignores the case of its letters only; the i flag would also let -c match -C. */
const anyCase = (text: string) => [...text].map((letter) => (/[a-z]/i.test(letter) ? `[${letter.toLowerCase()}${letter.toUpperCase()}]` : `\\${letter}`)).join("");
// A core.hooksPath or hook.* key (git config keys ignore case) set by -c or --config-env among git's
// options before its subcommand.
const HOOKS_OVERRIDE = new RegExp(String.raw`${START}${GIT}${option(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace"])}*?\s+(?:-c\s+|--config-env(?:=|\s+))['"]?(?:${anyCase("core.hookspath")}|${anyCase("hook.")})`);
// git config at the start of a line; its words decide whether it writes a hook key.
const GIT_CONFIG = new RegExp(String.raw`${START}${GIT}${GIT_DASH_C}\s+config(?![\w-])`, "g");
// A git invocation (at the start or after ;, &, |, or a newline, past any -C <path> options) that
// publishes or integrates history; merge-base and other hyphenated subcommands are not these.
const PUBLICATION = new RegExp(String.raw`${START}${GIT}${GIT_DASH_C}\s+(push|pull|merge|rebase|cherry-pick|revert|am|apply|tag)(?![\w-])`, "g");
// gh pr merge, with any options between its words.
const GH_OPTIONS = `${option(["-R", "--repo", "--hostname"])}*`;
const GH_PR_MERGE = new RegExp(String.raw`${START}${program("gh")}${GH_OPTIONS}\s+pr${GH_OPTIONS}\s+merge(?![\w-])`);

// `git tag` options: those that make it list or verify tags, those that create or delete one, and
// those that take the next word as their value.
const TAG_LISTS = new Set(["-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "-v", "--verify"]);
// Options that only change how a listing looks (-i is --ignore-case): neither a listing mode nor a creation.
const TAG_WRITES = new Set(["-a", "--annotate", "-s", "--sign", "-f", "--force", "-d", "--delete", "-e", "--edit", "-m", "--message", "-F", "--file", "-u", "--local-user", "--create-reflog", "--trailer", "--cleanup"]);
// --color takes only an attached =value, never the next word.
const TAG_VALUED = new Set(["-m", "--message", "-F", "--file", "-u", "--local-user", "--cleanup", "--trailer", "--sort", "--format", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged"]);
// Short tag options that select a listing mode.
const TAG_LIST_SHORT = /^-(l|v|n\d*)$/;

/**
 * True when `git tag` with these arguments only lists or verifies tags: no option that creates or
 * deletes one, and either a listing option or no tag name. Option values (-m <msg>) are values, not options.
 */
function tagReads(args: string[]): boolean {
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

// `git config` options that take the next word as their value, those that only read, and those that unset.
const CONFIG_VALUED = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--url"]);
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool"]);
const CONFIG_UNSETS = new Set(["--unset", "--unset-all"]);
// git 2.46+ `git config` subcommands that only read, and those that write a whole section.
const CONFIG_READ_ACTIONS = new Set(["get", "list"]);
const CONFIG_SECTION_WRITES = new Set(["remove-section", "rename-section", "--remove-section", "--rename-section"]);

/** True when a config key decides which hooks run: core.hooksPath, or any hook.* key (git 2.54 config-based hooks). */
function isHookKey(key: string): boolean {
	const lower = key.toLowerCase();
	return lower === "core.hookspath" || lower.startsWith("hook.");
}

/**
 * True when `git config` with these arguments sets or unsets a hook key, or removes or renames a hook
 * section. Reading one (`git config core.hooksPath`, `--get`, `get`) passes.
 */
function configWritesHookKey(args: string[]): boolean {
	const positional: string[] = [];
	let reads = false;
	let unsets = false;
	let sectionWrite = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (CONFIG_READS.has(arg)) reads = true;
		if (CONFIG_UNSETS.has(arg)) unsets = true;
		if (CONFIG_SECTION_WRITES.has(arg)) sectionWrite = true;
		if (CONFIG_VALUED.has(arg)) i++;
		else if (!arg.startsWith("-")) positional.push(arg);
	}
	if (positional[0] === "unset") unsets = true;
	if (positional[0] !== undefined && CONFIG_SECTION_WRITES.has(positional[0])) sectionWrite = true;
	const keyAt = positional.findIndex(isHookKey);
	if (keyAt === -1) return false;
	// Unsetting a hook key writes it too: in a husky repository, unsetting core.hooksPath turns its hooks off.
	if (sectionWrite || unsets) return true;
	if (reads || CONFIG_READ_ACTIONS.has(positional[0]!)) return false;
	// `git config <key>` alone reads it; a value after the key, `set`, `--add`, or `--replace-all` writes it.
	return keyAt + 1 < positional.length || positional[0] === "set" || args.some((arg) => arg === "--add" || arg === "--replace-all");
}

// A redirection word (2>/dev/null, >&2, 2>&1, &>log, <in); one that is only its operator takes the next word as its target.
const REDIRECTION = /^(?:\d*[<>]|&>)/;
const REDIRECTION_OPERATOR = /^(?:\d*(?:[<>]|>>|<<<?|<>|>\||[<>]&)|&>>?)$/;

/**
 * The words after a pattern's match up to the next separator or comment, with a quote at either end
 * removed and redirections and their targets dropped. The & of a redirection (2>&1, &>) is not a separator.
 */
function wordsAfter(command: string, match: RegExpMatchArray): string[] {
	const rest = command.slice(match.index! + match[0].length).split(/[;|\n)]|(?<![<>])&(?!>)/)[0]!;
	const words: string[] = [];
	let target = false;
	for (const word of rest.trim().split(/\s+/).filter(Boolean)) {
		if (word.startsWith("#")) break;
		if (target) target = false;
		else if (REDIRECTION.test(word)) target = REDIRECTION_OPERATOR.test(word);
		else words.push(word.replace(/^['"]|['"]$/g, ""));
	}
	return words;
}

/** How a command's text skips git hooks. */
export type HookSkip = "no-verify" | "short-n" | "skip-variable" | "hooks-config";

/** How the text skips git hooks, if it does: --no-verify, -n on commit or am, a skip variable, or a hook key override or config write. */
export function hookSkip(command: string): HookSkip | undefined {
	if (NO_VERIFY.test(command)) return "no-verify";
	for (const match of command.matchAll(GIT_COMMAND)) if (NO_VERIFY_FLAG.test(match[1]!)) return "no-verify";
	if (NO_VERIFY_SHORT.test(command)) return "short-n";
	if (SKIP_VARIABLE.test(command)) return "skip-variable";
	if (HOOKS_OVERRIDE.test(command)) return "hooks-config";
	for (const match of command.matchAll(GIT_CONFIG)) if (configWritesHookKey(wordsAfter(command, match))) return "hooks-config";
	return undefined;
}

/** The publication or integration command (`git push`, `git tag`, `gh pr merge`) a line of the text starts, skipping `git tag` forms that only list. */
export function publicationCommand(command: string): string | undefined {
	for (const match of command.matchAll(PUBLICATION)) {
		const subcommand = match[1]!;
		if (subcommand === "tag" && tagReads(wordsAfter(command, match))) continue;
		return `git ${subcommand}`;
	}
	return GH_PR_MERGE.test(command) ? "gh pr merge" : undefined;
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

const MENTION = "If the text only mentions it, as in a commit message, write the message to a file with the editor tool and run git commit -F <file>";
const HOOK_SKIP_REASONS: Record<HookSkip, string> = {
	"no-verify": "git guard blocked skipping git hooks with --no-verify after git, on its line or on a later line that a quoted string or a line-ending backslash carries the command onto: commit and push with hooks running, and fix what a hook reports instead of skipping it. If the text only mentions the flag, as in a commit message or a search, write the message to a file with the editor tool and run git commit -F <file> (or gh pr create --body-file <file> for a pull request body), or search for the flag without its leading dashes",
	"short-n": `git guard blocked skipping git hooks with -n (--no-verify) on git commit or git am, alone or among short flags such as -nm: commit with hooks running, and fix what a hook reports instead of skipping it. ${MENTION}`,
	"skip-variable": `git guard blocked skipping git hooks with a hook manager's skip variable (HUSKY, SKIP, LEFTHOOK, and the like) assigned on or just before a line that runs git: let the hooks run, and fix what a hook reports instead of skipping it. ${MENTION}`,
	"hooks-config": `git guard blocked skipping git hooks by setting or unsetting core.hooksPath or a hook.* key with git -c, --config-env, or git config: let the hooks run, and fix what a hook reports instead of skipping it; ask the user to change the key if the repository needs other hooks. ${MENTION}`,
};

/**
 * Why the actor may not run the command, or undefined when the policy allows it. Skipping hooks is
 * refused for every actor; publication and integration are refused for every child except an owner.
 */
export function blockReason(command: string, actor: Actor): string | undefined {
	const skip = hookSkip(command);
	if (skip !== undefined) return HOOK_SKIP_REASONS[skip];
	const publication = publicationCommand(command);
	if (!mayPublish(actor) && publication !== undefined) {
		const name = publication.split(" ")[0];
		return `git guard blocked child publication/integration command: ${publication}. Only the coordinating session or an ${PUBLISHING_CHILD_ROLE} publishes or integrates; commit locally and report the branch and head SHA to your parent instead. If the text only mentions the command, as in a commit message or a search, write the message to a file with the editor tool and run git commit -F <file>, or search without ${name} in front`;
	}
	return undefined;
}
