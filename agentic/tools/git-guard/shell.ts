// Splits a shell command line into the simple commands it would run, for the git guard. It is not a
// shell: it knows quoting, escapes, separators, command substitution, `sh -c` and `eval` strings, and
// the wrappers that run another command (`env`, `command`, `nohup`, `time`, ...), which is enough to
// find a git or gh invocation an agent writes. What it cannot see (variables, aliases, functions called
// by name, scripts) is listed as a gap in claude/README.md.

/** One simple command: its leading NAME=value assignments, the program word, and its arguments. */
export type Invocation = { assignments: string[]; program: string; args: string[] };

/** POSIX shells escape with a backslash and substitute with backticks; PowerShell escapes with a backtick. */
export type Dialect = "posix" | "powershell";

/** Thrown when a command nests deeper than the guard will follow; the guard refuses such a command. */
export class TooDeep extends Error {}

/** Command substitutions, `sh -c` strings, and `eval` strings are followed this many levels deep. */
export const NESTING_LIMIT = 8;

const SEPARATORS: Record<Dialect, Set<string>> = {
	posix: new Set([";", "&", "|", "\n", "(", ")"]),
	powershell: new Set([";", "&", "|", "\n", "(", ")", "{", "}"]),
};
const ESCAPE: Record<Dialect, string> = { posix: "\\", powershell: "`" };
// Words that may precede a command without being it. Each entry lists its options that take a value.
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);
const WRAPPERS = new Map<string, Set<string>>(Object.entries({
	command: new Set(),
	builtin: new Set(),
	exec: new Set(["-a"]),
	nohup: new Set(),
	time: new Set(["-o", "-f"]),
	noglob: new Set(),
	nice: new Set(["-n"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t", "-T"]),
	xargs: new Set(["-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
}));
const ENV_VALUED = new Set(["-u", "--unset", "-C", "--chdir", "-P"]);
const ENV_SPLIT = new Set(["-S", "--split-string"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The basename of a program word, lower-cased, without a Windows `.exe`: `/usr/bin/git` and `GIT.exe` are `git`. */
export function programName(word: string): string {
	return (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

/** Every simple command the line would run, including those inside substitutions and shell strings. */
export function invocations(command: string, dialect: Dialect): Invocation[] {
	const found: Invocation[] = [];
	collect(command, dialect, 0, found);
	return found;
}

function collect(text: string, dialect: Dialect, depth: number, found: Invocation[]): void {
	if (depth > NESTING_LIMIT) throw new TooDeep(`the command nests more than ${NESTING_LIMIT} levels of substitution or shell strings`);
	const nested = (inner: string, innerDialect: Dialect = dialect) => collect(inner, innerDialect, depth + 1, found);
	for (const words of segments(text, dialect, nested)) {
		const invocation = unwrap(words, nested);
		if (invocation) found.push(invocation);
	}
}

/** Index just past the `)` that closes the `(` before `start`, honoring quotes; text.length if unclosed. */
function closingParen(text: string, start: number, escape: string): number {
	let depth = 1;
	let i = start;
	while (i < text.length) {
		const c = text[i]!;
		if (c === escape) i += 2;
		else if (c === "'") i = skipTo(text, i + 1, "'", escape) + 1;
		else if (c === '"') i = skipTo(text, i + 1, '"', escape) + 1;
		else {
			if (c === "(") depth++;
			if (c === ")") depth--;
			i++;
			if (depth === 0) return i;
		}
	}
	return text.length;
}

/** Index of the next unescaped `quote` at or after `start` (single quotes take no escapes); text.length if none. */
function skipTo(text: string, start: number, quote: string, escape: string): number {
	let i = start;
	while (i < text.length && text[i] !== quote) i += quote !== "'" && text[i] === escape ? 2 : 1;
	return Math.min(i, text.length);
}

/** The words of each simple command, split at separators; substitutions are handed to `nested`. */
function segments(text: string, dialect: Dialect, nested: (inner: string) => void): string[][] {
	const escape = ESCAPE[dialect];
	const separators = SEPARATORS[dialect];
	const result: string[][] = [];
	let words: string[] = [];
	let word: string | undefined;
	const endWord = () => {
		if (word !== undefined) words.push(word);
		word = undefined;
	};
	const endSegment = () => {
		endWord();
		if (words.length) result.push(words);
		words = [];
	};
	const append = (s: string) => {
		word = (word ?? "") + s;
	};
	let i = 0;
	while (i < text.length) {
		const c = text[i]!;
		const next = text[i + 1];
		if (c === escape) {
			if (next !== "\n" && next !== undefined) append(next);
			i += 2;
		} else if (c === "'") {
			const end = skipTo(text, i + 1, "'", escape);
			append(text.slice(i + 1, end));
			i = end + 1;
		} else if (c === '"') {
			i = doubleQuoted(text, i + 1, escape, append, nested);
		} else if (c === "`") {
			const end = skipTo(text, i + 1, "`", escape);
			nested(text.slice(i + 1, end));
			append("`...`");
			i = end + 1;
		} else if ((c === "$" || c === "<" || c === ">") && next === "(") {
			const end = closingParen(text, i + 2, escape);
			nested(text.slice(i + 2, end - 1));
			append("$(...)");
			i = end;
		} else if (c === "#" && word === undefined) {
			i = skipTo(text, i, "\n", escape);
		} else if (separators.has(c)) {
			endSegment();
			i++;
		} else if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
		} else {
			append(c);
			i++;
		}
	}
	endSegment();
	return result;
}

/** Reads a double-quoted string from `start`; returns the index past its closing quote. */
function doubleQuoted(text: string, start: number, escape: string, append: (s: string) => void, nested: (inner: string) => void): number {
	let i = start;
	append("");
	while (i < text.length && text[i] !== '"') {
		const c = text[i]!;
		const next = text[i + 1];
		if (c === escape && next !== undefined) {
			// POSIX keeps a backslash before an ordinary character; it only escapes " \\ $ ` and a newline.
			if (escape === "\\" && !'"\\$`\n'.includes(next)) append(c);
			if (next !== "\n") append(next);
			i += 2;
		} else if (c === "`") {
			const end = skipTo(text, i + 1, "`", escape);
			nested(text.slice(i + 1, end));
			i = end + 1;
		} else if (c === "$" && next === "(") {
			const end = closingParen(text, i + 2, escape);
			nested(text.slice(i + 2, end - 1));
			i = end;
		} else {
			append(c);
			i++;
		}
	}
	return i + 1;
}

/** Skips options (and the values of `valued` ones) from `start`; returns the index of the first operand. */
function skipOptions(words: string[], start: number, valued: Set<string>): number {
	let i = start;
	while (i < words.length && words[i]!.startsWith("-") && words[i] !== "-") {
		i += valued.has(words[i]!) ? 2 : 1;
	}
	return i;
}

/** Strips assignments, keywords, and wrappers, follows `env -S`, `sh -c`, and `eval` strings, and returns the command left. */
function unwrap(words: string[], nested: (inner: string, dialect?: Dialect) => void): Invocation | undefined {
	const assignments: string[] = [];
	let i = 0;
	// Each pass consumes at least one word, so this ends within words.length passes.
	while (i < words.length) {
		const word = words[i]!;
		const name = programName(word);
		if (ASSIGNMENT.test(word)) {
			assignments.push(word);
			i++;
		} else if (KEYWORDS.has(word)) {
			i++;
		} else if (name === "env") {
			i++;
			while (i < words.length && (words[i]!.startsWith("-") || ASSIGNMENT.test(words[i]!))) {
				const option = words[i]!;
				if (ASSIGNMENT.test(option)) assignments.push(option);
				if (ENV_SPLIT.has(option) && i + 1 < words.length) nested(words[i + 1]!);
				i += ENV_VALUED.has(option) || ENV_SPLIT.has(option) ? 2 : 1;
			}
		} else if (WRAPPERS.has(name)) {
			i = skipOptions(words, i + 1, WRAPPERS.get(name)!);
			// timeout and nice -N take a leading duration or niceness operand.
			if (name === "timeout" && i < words.length && /^\d/.test(words[i]!)) i++;
		} else {
			break;
		}
	}
	if (i >= words.length) return undefined;
	const program = words[i]!;
	const args = words.slice(i + 1);
	followShellString(programName(program), args, nested);
	return { assignments, program, args };
}

/** Hands the command string of `sh -c`, `pwsh -Command`, `eval`, or `Invoke-Expression` to `nested`. */
function followShellString(name: string, args: string[], nested: (inner: string, dialect?: Dialect) => void): void {
	if (name === "eval" || name === "invoke-expression" || name === "iex") {
		nested(args.join(" "));
		return;
	}
	if (SHELLS.has(name)) {
		const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
		if (flag !== -1 && flag + 1 < args.length) nested(args[flag + 1]!, "posix");
		return;
	}
	if (POWERSHELLS.has(name)) {
		const flag = args.findIndex((arg) => /^-(c|command|commandwithargs|cwa)$/i.test(arg));
		if (flag !== -1 && flag + 1 < args.length) nested(args.slice(flag + 1).join(" "), "powershell");
	}
}
