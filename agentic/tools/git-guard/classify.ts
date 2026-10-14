// The git command policy both runtimes enforce on a shell command before it runs: Pi's git-interceptor
// extension and Claude Code's PreToolUse hook (cli.ts). Each runtime decides who is acting; this module
// decides what that actor may run. It reads the command text only and never runs anything.
//
// The policy is text patterns: the two kept from Pi's original interceptor (--no-verify, and publication
// or integration), narrowed only where they matched other git commands (--no-verify-signatures,
// merge-base, and listing tags), and patterns for what a shell reader, since removed, used to find:
// git commit or am -n, a hook manager's skip variable, a core.hooksPath or hook.* override or config
// write, and gh pr merge. They find git or gh, by name or absolute path, at the start of a line or after
// ;, &, or |, past assignments that prefix it on its line (GIT_EDITOR=true git commit, X=$(date) git
// push; VALUE says which values they read), so they also match a mention in a quoted message or a
// search, and each reason says how to rephrase one. --no-verify also counts on a later line that a
// quoted string or a line-ending backslash carries git's command onto. They do not read the shell
// otherwise: git reached another way (a wrapper, a substitution, a `sh -c` string) is not seen.
//
// CommandText finds where each command starts and reads the assignments before it once per text, so a
// text whose quoted values hold many separators (each a command's start) is still read in linear time;
// each pattern below starts at the git or gh it finds there.

/** Who issued the command. The coordinating session publishes; a child publishes only as an autopilot-full owner. */
export type Actor = { kind: "main" } | { kind: "child"; role: string | undefined };

/** The one child role that carries its own pull request through the merge (babysit-and-ship). */
export const PUBLISHING_CHILD_ROLE = "autopilot-owner";

/** A program by name or by absolute path (/usr/bin/git). */
const program = (name: string) => String.raw`(?:(?:/[^\s/;&|<>()'"]*)*/)?${name}`;
const GIT = program("git");
// git's -C <path> options, the only options the patterns skip before a subcommand. A path is a run of
// quoted and bare parts; each part starts with a different character and a bare part holds no
// whitespace, so a run of options reads one way and cannot backtrack exponentially.
const GIT_DASH_C = String.raw`(?:\s+-C\s+(?:'[^']*'|"[^"]*"|[^\s'"])+)*`;
// One word: quoted, or up to whitespace or a separator.
const WORD = String.raw`(?:'[^'\n]*'|"[^"\n]*"|[^\s;&|'"]+)`;
// What separates the assignments that prefix one command: spaces, tabs, and a backslash-newline, which
// the shell removes. A newline ends the command.
const BLANK = String.raw`(?:[^\S\n]|\\\n)`;
// Whitespace of any kind, newlines included, and backslash-newlines.
const SPACE = String.raw`(?:\s|\\\n)`;
// Where a value ends: whitespace, a separator, a backslash-newline, or the end of the text.
const VALUE_END = String.raw`(?=[\s;&|]|\\\n|$)`;
// An assignment's value, as parts: a single-quoted string, a double-quoted string (its backslash escapes
// included), a $(...) substitution holding no parenthesis, a ${...} expansion holding no brace, a
// backquoted substitution, a backslash escape of anything but a newline or a separator, and an unquoted
// character that starts none of these and is not a parenthesis. No part spans lines. Each part starts
// with a different character, so a value reads one way (an escaped quote, as in \', is an escape, never
// a quote's start), and it is read whole, up to VALUE_END, so a long value cannot backtrack into many
// shorter ones.
const VALUE = String.raw`(?:'[^'\n]*'|"[^"\\\n]*(?:\\[^\n][^"\\\n]*)*"|\$\([^()\n]*\)|\$\{[^{}\n]*\}|\$(?![({])|\x60[^\x60\\\n]*(?:\\[^\n][^\x60\\\n]*)*\x60|\\[^\n;&|]|[^\s;&|'"\\$\x60()])*${VALUE_END}`;
// An assignment's value read as a word: quoted strings without escapes, and any other character but
// whitespace, a separator, or a backslash before a newline. It reads values VALUE does not, such as
// $((n+1)) and ${A:-${B}}, as long as they hold no whitespace; the skip-variable check reads values both
// ways, so a value either reading accepts can carry a skip variable. Its parts also start with different
// characters.
const WORD_VALUE = String.raw`(?:'[^'\n]*'|"[^"\n]*"|\\(?!\n)|[^\s;&|'"\\])*${VALUE_END}`;
/** One assignment at the position it is tried at, with = or += (X+=1); the name is group 1. */
const assignment = (value: string) => new RegExp(String.raw`([A-Za-z_]\w*)\+?=${value}`, "y");
const ASSIGNMENT = assignment(VALUE);
const WORD_ASSIGNMENT = assignment(WORD_VALUE);

// --no-verify, but not git's own --no-verify-signatures.
const NO_VERIFY_FLAG = new RegExp(String.raw`--no-verify(?![\w-])`);
// --no-verify after a git that starts a command.
const NO_VERIFY = new RegExp(String.raw`${GIT}\s+[^\n]*${NO_VERIFY_FLAG.source}`, "y");
// A git that starts a command, and the rest of its command: unquoted text up to a newline or a comment,
// with quoted strings and backslash escapes that may carry it onto later lines (a commit message in a
// here document, or a backslash at a line's end). Each alternative starts with a different character,
// so the text reads one way.
const GIT_COMMAND = new RegExp(String.raw`${GIT}[^\S\n]((?:[^\n'"\\\s#]|[^\S\n](?!#)|(?<!\s)#|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*")*)`, "y");
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
const NO_VERIFY_SHORT = new RegExp(String.raw`${GIT}${GIT_DASH_C}\s+(?:commit(?![\w-])[^\n;&|]*?${shortN(COMMIT_SHORT_FLAGS, COMMIT_LONG_LIKE_N)}|am(?![\w-])[^\n;&|]*?${shortN(AM_SHORT_FLAGS, AM_LONG_LIKE_N)})`, "y");
// Variables hook managers read to skip hooks: husky, pre-commit, lefthook, overcommit.
const SKIP_VARIABLES = new Set(["HUSKY_SKIP_HOOKS", "HUSKY", "SKIP", "PRE_COMMIT_ALLOW_NO_CONFIG", "LEFTHOOK_EXCLUDE", "LEFTHOOK", "OVERCOMMIT_DISABLE"]);
// export and its kin before the assignments of a command's start: they put a variable in the environment
// of every later command, so the skip-variable check lets their assignments run onto later lines.
const EXPORT = new RegExp(String.raw`(?:export|declare|typeset|local|readonly)(?:${SPACE}+-\w+)*${SPACE}+`, "y");
// git after a run of assignments, on its line or, after export, on a later one.
const GIT_AFTER_BLANK = new RegExp(String.raw`${BLANK}+${GIT}\s`, "y");
const GIT_AFTER_SPACE = new RegExp(String.raw`${SPACE}+${GIT}\s`, "y");
// A git after ;, &, or |: a skip variable earlier on the separator's line reaches it (export HUSKY=0; git push).
const SEPARATOR_GIT = new RegExp(String.raw`[;&|]\s*${GIT}\s`, "g");
/** One option: a `valued` option and the next word, or any other option word. The two never overlap, so a run of options reads one way and cannot backtrack exponentially. */
function option(valued: string[]): string {
	const names = valued.join("|");
	return String.raw`(?:\s+(?:${names})\s+${WORD}|\s+(?!(?:${names})(?:\s|$))-[^\s;&|]+)`;
}
/** A pattern for `text` that ignores the case of its letters only; the i flag would also let -c match -C. */
const anyCase = (text: string) => [...text].map((letter) => (/[a-z]/i.test(letter) ? `[${letter.toLowerCase()}${letter.toUpperCase()}]` : `\\${letter}`)).join("");
// A core.hooksPath or hook.* key (git config keys ignore case) set by -c or --config-env among git's
// options before its subcommand.
const HOOKS_OVERRIDE = new RegExp(String.raw`${GIT}${option(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace"])}*?\s+(?:-c\s+|--config-env(?:=|\s+))['"]?(?:${anyCase("core.hookspath")}|${anyCase("hook.")})`, "y");
// git config starting a command; its words decide whether it writes a hook key.
const GIT_CONFIG = new RegExp(String.raw`${GIT}${GIT_DASH_C}\s+config(?![\w-])`, "y");
// A git invocation (past any -C <path> options) that publishes or integrates history; merge-base and
// other hyphenated subcommands are not these.
const PUBLICATION = new RegExp(String.raw`${GIT}${GIT_DASH_C}\s+(push|pull|merge|rebase|cherry-pick|revert|am|apply|tag)(?![\w-])`, "y");
// gh pr merge, with any options between its words.
const GH_OPTIONS = `${option(["-R", "--repo", "--hostname"])}*`;
const GH_PR_MERGE = new RegExp(String.raw`${program("gh")}${GH_OPTIONS}\s+pr${GH_OPTIONS}\s+merge(?![\w-])`, "y");

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
 * The words after `end` up to the next separator or comment, with a quote at either end removed and
 * redirections and their targets dropped. The & of a redirection (2>&1, &>) is not a separator.
 */
function wordsAfter(command: string, end: number): string[] {
	const rest = command.slice(end).split(/[;|\n)]|(?<![<>])&(?!>)/)[0]!;
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

const isSeparator = (character: string) => ";&|\n".includes(character);
const BLANKS = new RegExp(`${BLANK}+`, "y");
const SPACES = new RegExp(`${SPACE}+`, "y");

/** A run of assignments read from one position: where its last value ends, and where the first skip variable's value in it ends (-1 for none). */
type Chain = { end: number; skipEnd: number };
/** A pattern's match at a command's git or gh, and where it ends in the text. */
type Found = { end: number; match: RegExpExecArray };

/**
 * The runs of assignments that `assignment` reads in `text`, `gap` apart, from any position. Each run is
 * remembered by where it starts, so the runs from many starts that reach the same assignment (as those
 * from each separator inside a quoted value do) read the rest once, and all of them take linear time.
 */
function chains(text: string, assignment: RegExp, gap: RegExp): (at: number) => Chain | undefined {
	const known = new Map<number, Chain | undefined>();
	return (from) => {
		const path: { at: number; end: number; skip: boolean }[] = [];
		let rest: Chain | undefined;
		for (let at = from; ; ) {
			if (known.has(at)) {
				rest = known.get(at);
				break;
			}
			assignment.lastIndex = at;
			const match = assignment.exec(text);
			if (match === null) {
				known.set(at, undefined);
				break;
			}
			const end = at + match[0].length;
			path.push({ at, end, skip: SKIP_VARIABLES.has(match[1]!) });
			gap.lastIndex = end;
			const space = gap.exec(text);
			if (space === null) break;
			at = end + space[0].length;
		}
		for (const { at, end, skip } of path.reverse()) {
			rest = { end: rest?.end ?? end, skipEnd: skip ? end : (rest?.skipEnd ?? -1) };
			known.set(at, rest);
		}
		return rest;
	};
}

/** The first number in the ascending `sorted` that is at least `value`, or undefined. */
function firstFrom(sorted: number[], value: number): number | undefined {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (sorted[middle]! < value) low = middle + 1;
		else high = middle;
	}
	return sorted[low];
}

/**
 * A command text and where its commands start: the start of the text, and each ;, &, |, or newline
 * (with the whitespace after it), past the assignments that prefix that command on its line
 * (GIT_EDITOR=true git commit).
 */
class CommandText {
	/** The position of each command's start: 0 and each separator, ascending. */
	private readonly starts: number[] = [0];
	/** For each position, the first position at or after it that is not whitespace. */
	private readonly nonSpace: Int32Array;
	/** The assignments that prefix a command, read as VALUE reads values, on one line. */
	private readonly sameLine: (at: number) => Chain | undefined;

	constructor(readonly text: string) {
		for (let i = 0; i < text.length; i++) if (isSeparator(text[i]!)) this.starts.push(i);
		this.nonSpace = new Int32Array(text.length + 1).fill(text.length);
		for (let i = text.length - 1; i >= 0; i--) this.nonSpace[i] = /\s/.test(text[i]!) ? this.nonSpace[i + 1]! : i;
		this.sameLine = chains(text, ASSIGNMENT, BLANKS);
	}

	/** Where the command at `start` begins: past its separator and the whitespace after it, or at 0. */
	private commandAt(start: number): number {
		return start === 0 && !isSeparator(this.text[0] ?? "") ? 0 : this.nonSpace[start + 1]!;
	}

	/** Where git or gh may start in the command at `start`: past its assignments and the blanks after them, or undefined when only assignments are there. */
	private programAt(start: number): number | undefined {
		const at = this.commandAt(start);
		const chain = this.sameLine(at);
		if (chain === undefined) return at;
		BLANKS.lastIndex = chain.end;
		return BLANKS.test(this.text) ? BLANKS.lastIndex : undefined;
	}

	/** The match of the sticky `pattern` at the git or gh of the command at `start`. */
	private matchAt(pattern: RegExp, start: number): Found | undefined {
		const at = this.programAt(start);
		if (at === undefined) return undefined;
		pattern.lastIndex = at;
		const match = pattern.exec(this.text);
		return match === null ? undefined : { end: at + match[0].length, match };
	}

	/** True when `pattern` matches at the git or gh of any command. */
	some(pattern: RegExp): boolean {
		return this.starts.some((start) => this.matchAt(pattern, start) !== undefined);
	}

	/**
	 * Every match of `pattern` at a command, left to right, past the end of the one before, and also
	 * every match at a separator inside an earlier match before its body (`bodyStart`, by default the
	 * match's end): a command inside an assignment's value, such as the `git push` in
	 * `X=$(true; git push) git tag -l`. No match's body is searched again, so a match that reads on past
	 * later commands (GIT_COMMAND's) is not read again from each of them.
	 */
	*every(pattern: RegExp, bodyStart = (found: Found) => found.end): Generator<Found> {
		let resume = 0;
		for (let index = 0; index < this.starts.length; index++) {
			if (this.starts[index]! < resume) continue;
			const found = this.matchAt(pattern, this.starts[index]!);
			if (found === undefined) continue;
			yield found;
			const prefixEnd = bodyStart(found);
			// The body of the latest match found inside this one's prefix, which is not searched again.
			let skip = { from: prefixEnd, to: prefixEnd };
			for (let inner = index + 1; inner < this.starts.length && this.starts[inner]! < prefixEnd; inner++) {
				const start = this.starts[inner]!;
				if (start >= skip.from && start < skip.to) continue;
				const innerFound = this.matchAt(pattern, start);
				if (innerFound === undefined) continue;
				yield innerFound;
				skip = { from: bodyStart(innerFound), to: innerFound.end };
			}
			resume = found.end;
		}
	}

	/**
	 * True when a hook manager's skip variable is assigned where a command starts (alone, among other
	 * assignments, or after export and its kin) and git runs with it: as that command (HUSKY=0 git
	 * commit), after a separator on its line (HUSKY=0; git push), or, when exported, at the start of a
	 * later line that only assignments come before (export HUSKY=0, then git commit). Values are read both
	 * as VALUE and as WORD_VALUE reads them, so a value either reading accepts can carry a skip variable.
	 */
	skipVariable(): boolean {
		const text = this.text;
		const separatorGits = [...text.matchAll(SEPARATOR_GIT)].map((match) => match.index);
		// The newlines that end a line; a backslash-newline continues it.
		const newlines = this.starts.filter((start) => text[start] === "\n" && text[start - 1] !== "\\");
		// A ;, &, or | at or after `at` on its line, with git after it.
		const separatorGitFrom = (at: number) => {
			const separator = firstFrom(separatorGits, at);
			const newline = firstFrom(newlines, at);
			return separator !== undefined && (newline === undefined || separator < newline);
		};
		// Assignments on one line, then git after blanks; or, after export, on any lines, then git after any whitespace.
		const oneLine = { chains: [this.sameLine, chains(text, WORD_ASSIGNMENT, BLANKS)], git: GIT_AFTER_BLANK, gitAt: new Map<number, boolean>() };
		const exported = { chains: [chains(text, ASSIGNMENT, SPACES), chains(text, WORD_ASSIGNMENT, SPACES)], git: GIT_AFTER_SPACE, gitAt: new Map<number, boolean>() };
		for (const start of this.starts) {
			let at = this.commandAt(start);
			EXPORT.lastIndex = at;
			const reading = EXPORT.test(text) ? exported : oneLine;
			if (reading === exported) at = EXPORT.lastIndex;
			for (const chainAt of reading.chains) {
				const chain = chainAt(at);
				if (chain === undefined || chain.skipEnd === -1) continue;
				if (separatorGitFrom(chain.skipEnd)) return true;
				if (!reading.gitAt.has(chain.end)) {
					reading.git.lastIndex = chain.end;
					reading.gitAt.set(chain.end, reading.git.test(text));
				}
				if (reading.gitAt.get(chain.end)) return true;
			}
		}
		return false;
	}
}

/** How a command's text skips git hooks. */
export type HookSkip = "no-verify" | "short-n" | "skip-variable" | "hooks-config";

/** How the text skips git hooks, if it does: --no-verify, -n on commit or am, a skip variable, or a hook key override or config write. */
export function hookSkip(command: string): HookSkip | undefined {
	const text = new CommandText(command);
	if (text.some(NO_VERIFY)) return "no-verify";
	for (const { match } of text.every(GIT_COMMAND, (found) => found.end - found.match[1]!.length)) if (NO_VERIFY_FLAG.test(match[1]!)) return "no-verify";
	if (text.some(NO_VERIFY_SHORT)) return "short-n";
	if (text.skipVariable()) return "skip-variable";
	if (text.some(HOOKS_OVERRIDE)) return "hooks-config";
	for (const { end } of text.every(GIT_CONFIG)) if (configWritesHookKey(wordsAfter(command, end))) return "hooks-config";
	return undefined;
}

/** The publication or integration command (`git push`, `git tag`, `gh pr merge`) a line of the text starts, skipping `git tag` forms that only list. */
export function publicationCommand(command: string): string | undefined {
	const text = new CommandText(command);
	for (const { end, match } of text.every(PUBLICATION)) {
		const subcommand = match[1]!;
		if (subcommand === "tag" && tagReads(wordsAfter(command, end))) continue;
		return `git ${subcommand}`;
	}
	return text.some(GH_PR_MERGE) ? "gh pr merge" : undefined;
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
