// Splits a shell command line into the simple commands it would run, for the git guard. It is not a
// shell: it knows quoting (including ANSI-C $'...'), escapes, comments, separators, redirections, here
// documents and here-strings, command substitution, `sh -c` and `eval` strings, and the wrappers that
// run another command (`env`, `command`, `nohup`, `find -exec`, ...), which is enough to find a git or
// gh invocation an agent writes. Text it cannot read (an unclosed quote, substitution, or here
// document, nesting past NESTING_LIMIT, a glob in a program name) throws Unreadable, which the guard
// refuses. What it cannot see (variables, aliases, functions called by name, scripts) is listed as a
// gap in claude/README.md.

/** One simple command: its leading NAME=value assignments, the program word, and its arguments. */
export type Invocation = { assignments: string[]; program: string; args: string[] };

/** POSIX shells escape with a backslash and substitute with backticks; PowerShell escapes with a backtick. */
export type Dialect = "posix" | "powershell";

/** Thrown for a command the reader cannot read with confidence; the guard refuses such a command. */
export class Unreadable extends Error {}

/** Command substitutions, subshells, shell strings, and fed here documents are followed this many levels deep. */
export const NESTING_LIMIT = 8;

/** A word and whether it holds an unquoted glob or brace character, which would make it a pattern. */
type Word = { text: string; glob: boolean };
/** A simple command's words, the text on its standard input (here documents and here-strings), and whether it pipes into the next. */
type Segment = { words: Word[]; stdin: StdinText[]; pipes: boolean };
type StdinText = { text: string; dialect: Dialect };
type PendingHeredoc = { delimiter: string; stripTabs: boolean; quoted: boolean; target: StdinText[] };

// A word holding a redirection operator starts with this character, which no command text produces.
const REDIRECTION = "\u0000";
const GLOB = /[*?[{}]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Words that may precede a command without being it (shell keywords, and zsh's precommand modifiers).
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "-", "nocorrect"]);
// Wrappers that run the rest of their arguments as a command, with their options that take a value.
const WRAPPERS = new Map<string, Set<string>>(Object.entries({
	command: new Set<string>(),
	builtin: new Set<string>(),
	exec: new Set(["-a"]),
	nohup: new Set<string>(),
	time: new Set(["-o", "-f"]),
	noglob: new Set<string>(),
	nice: new Set(["-n"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t", "-T"]),
	xargs: new Set(["-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	caffeinate: new Set(["-t", "-w"]),
	arch: new Set(["-arch", "-e", "-d"]),
	busybox: new Set<string>(),
}));
const ENV_VALUED = new Set(["-u", "--unset", "-C", "--chdir", "-P"]);
const FLOCK_VALUED = new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]);
const WATCH_VALUED = new Set(["-n", "--interval", "-q", "--equexit", "-s", "--shell"]);
const WSL_VALUED = new Set(["-d", "--distribution", "-u", "--user", "--cd", "--shell-type", "--distribution-id"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
const ANSI_C: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** The basename of a program word, lower-cased, without a Windows `.exe`: `/usr/bin/git` and `GIT.exe` are `git`. */
export function programName(word: string): string {
	return (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

/** Every simple command the line would run, including those inside substitutions, shell strings, and fed here documents. Throws Unreadable. */
export function invocations(command: string, dialect: Dialect): Invocation[] {
	const found: Invocation[] = [];
	new Reader(command, dialect, 0, found).run();
	return found;
}

/** True when a program reads its standard input as commands: a shell, or PowerShell. */
function readsCommands(program: string): Dialect | undefined {
	const name = programName(program);
	if (SHELLS.has(name)) return "posix";
	if (POWERSHELLS.has(name)) return "powershell";
	return undefined;
}

class Reader {
	private pos = 0;
	private readonly escape: string;

	constructor(private readonly text: string, private readonly dialect: Dialect, private readonly depth: number, private readonly found: Invocation[]) {
		if (depth > NESTING_LIMIT) throw new Unreadable(`it nests more than ${NESTING_LIMIT} levels of substitution, subshell, or shell string`);
		this.escape = dialect === "posix" ? "\\" : "`";
	}

	/** Reads the whole text as a command list and records every invocation in it. */
	run(): void {
		this.analyze(this.list(undefined));
		if (this.pos < this.text.length) throw new Unreadable("the reader stopped before the end of the command");
	}

	/** Reads text nested inside this text (a substitution or subshell) from `pos` up to its `)`, as commands. */
	private nestedHere(): void {
		const inner = new Reader(this.text, this.dialect, this.depth + 1, this.found);
		inner.pos = this.pos;
		inner.analyze(inner.list(")"));
		this.pos = inner.pos;
	}

	/** Reads a separate string as commands, such as an `sh -c` argument or a here document fed to a shell. */
	nestedString(text: string, dialect: Dialect = this.dialect): void {
		new Reader(text, dialect, this.depth + 1, this.found).run();
	}

	/** Records the substitutions in text a shell expands but does not run, such as an unquoted here document body. */
	private substitutionsIn(text: string): void {
		const inner = new Reader(text, "posix", this.depth + 1, this.found);
		while (inner.pos < text.length) {
			const c = text[inner.pos]!;
			if (c === "\\") inner.pos += 2;
			else if (c === "`") inner.backtick();
			else if (c === "$" && text[inner.pos + 1] === "(") {
				inner.pos += 2;
				inner.nestedHere();
			} else inner.pos++;
		}
	}

	/** Reads `...` from the opening backtick at `pos` and its command. */
	private backtick(): void {
		const end = this.text.indexOf("`", this.pos + 1);
		if (end === -1) throw new Unreadable("a backtick substitution is never closed");
		this.nestedString(this.text.slice(this.pos + 1, end));
		this.pos = end + 1;
	}

	/** Splits commands until `closer` or the end, reading quotes, substitutions, redirections, and here documents. */
	private list(closer: ")" | undefined): Segment[] {
		const segments: Segment[] = [];
		let words: Word[] = [];
		let stdin: StdinText[] = [];
		let word: Word | undefined;
		const pending: PendingHeredoc[] = [];
		const append = (s: string, glob = false) => {
			word = { text: (word?.text ?? "") + s, glob: (word?.glob ?? false) || glob };
		};
		const endWord = () => {
			if (word !== undefined) words.push(word);
			word = undefined;
		};
		const endSegment = (pipes: boolean) => {
			endWord();
			if (words.length || stdin.length) segments.push({ words, stdin, pipes });
			words = [];
			stdin = [];
		};
		const text = this.text;
		while (this.pos < text.length) {
			const c = text[this.pos]!;
			const next = text[this.pos + 1];
			if (closer !== undefined && c === closer) {
				endSegment(false);
				this.pos++;
				if (pending.length) throw new Unreadable(`a here document (${pending[0]!.delimiter}) is never closed`);
				return segments;
			}
			if (c === "\n") {
				endSegment(false);
				this.pos++;
				this.heredocBodies(pending);
			} else if (c === this.escape) {
				if (next !== undefined && next !== "\n") append(next);
				this.pos += 2;
			} else if (c === "'") {
				append(this.singleQuoted());
			} else if (this.dialect === "posix" && c === "$" && next === "'") {
				this.pos++;
				append(this.ansiC());
			} else if (c === "$" && next === "{") {
				// ${name...} is a parameter expansion, not a brace pattern.
				const end = text.indexOf("}", this.pos);
				if (end === -1) throw new Unreadable("a ${ parameter expansion is never closed");
				append(text.slice(this.pos, end + 1));
				this.pos = end + 1;
			} else if (c === '"') {
				append(this.doubleQuoted());
			} else if (this.dialect === "posix" && c === "`") {
				this.backtick();
				append("`...`");
			} else if (this.dialect === "posix" && c === "$" && next === "(" && text[this.pos + 2] === "(") {
				// $(( )) is arithmetic, whose << and >> are shifts, not redirections.
				append(this.arithmetic());
			} else if ((c === "$" || c === "<" || c === ">") && next === "(") {
				this.pos += 2;
				this.nestedHere();
				append("$(...)");
			} else if (c === "(") {
				endSegment(false);
				this.pos++;
				this.nestedHere();
			} else if (c === ")" || (this.dialect === "powershell" && (c === "{" || c === "}"))) {
				endSegment(false);
				this.pos++;
			} else if (c === "#" && word === undefined) {
				const end = text.indexOf("\n", this.pos);
				this.pos = end === -1 ? text.length : end;
			} else if (this.dialect === "posix" && c === "<" && next === "<" && text[this.pos + 2] !== "<") {
				if (word !== undefined && /^\d+$/.test(word.text)) word = undefined;
				endWord();
				pending.push(this.heredocStart(stdin));
			} else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
				if (word !== undefined && /^(\d+|\*)$/.test(word.text)) word = undefined;
				endWord();
				words.push({ text: REDIRECTION + this.redirection(), glob: false });
			} else if (c === ";" || c === "&" || c === "|") {
				const pipes = c === "|" && next !== "|";
				endSegment(pipes);
				this.pos += next === c || (c === "|" && next === "&") ? 2 : 1;
			} else if (c === " " || c === "\t" || c === "\r") {
				endWord();
				this.pos++;
			} else {
				append(c, this.dialect === "posix" && GLOB.test(c));
				this.pos++;
			}
		}
		endSegment(false);
		if (closer !== undefined) throw new Unreadable("a $( or ( is never closed");
		if (pending.length) throw new Unreadable(`a here document (${pending[0]!.delimiter}) is never closed`);
		return segments;
	}

	/** Reads $(( ... )) from `pos` as literal text, matching parentheses. */
	private arithmetic(): string {
		const start = this.pos;
		let depth = 0;
		while (this.pos < this.text.length) {
			const c = this.text[this.pos++]!;
			if (c === "(") depth++;
			if (c === ")" && --depth === 0) return this.text.slice(start, this.pos);
		}
		throw new Unreadable("a $(( arithmetic expansion is never closed");
	}

	/** Reads a redirection operator at `pos` (>, >>, >|, >&, <, <&, <>, <<<, &>, &>>) and returns it. */
	private redirection(): string {
		const start = this.pos;
		if (this.text[this.pos] === "&") this.pos++;
		while (this.pos - start < 4 && (this.text[this.pos] === ">" || this.text[this.pos] === "<")) this.pos++;
		if (this.text[this.pos] === "&" || this.text[this.pos] === "|") this.pos++;
		return this.text.slice(start, this.pos);
	}

	/** Reads `<<` or `<<-` and its delimiter word; the body is read at the next newline. */
	private heredocStart(target: StdinText[]): PendingHeredoc {
		this.pos += 2;
		const stripTabs = this.text[this.pos] === "-";
		if (stripTabs) this.pos++;
		while (this.text[this.pos] === " " || this.text[this.pos] === "\t") this.pos++;
		let delimiter = "";
		let quoted = false;
		while (this.pos < this.text.length && !" \t\n;&|<>()".includes(this.text[this.pos]!)) {
			const c = this.text[this.pos]!;
			if (c === "'") {
				quoted = true;
				delimiter += this.singleQuoted();
			} else if (c === '"') {
				quoted = true;
				delimiter += this.doubleQuoted();
			} else if (c === "\\") {
				quoted = true;
				delimiter += this.text[this.pos + 1] ?? "";
				this.pos += 2;
			} else {
				delimiter += c;
				this.pos++;
			}
		}
		if (delimiter === "") throw new Unreadable("a here document has no delimiter");
		return { delimiter, stripTabs, quoted, target };
	}

	/** Reads the bodies of the pending here documents, in order, from the line at `pos`. */
	private heredocBodies(pending: PendingHeredoc[]): void {
		for (const heredoc of pending.splice(0)) {
			const lines: string[] = [];
			for (;;) {
				if (this.pos >= this.text.length) throw new Unreadable(`a here document (${heredoc.delimiter}) is never closed`);
				const end = this.text.indexOf("\n", this.pos);
				const raw = this.text.slice(this.pos, end === -1 ? this.text.length : end);
				this.pos = end === -1 ? this.text.length : end + 1;
				const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
				if (line === heredoc.delimiter) break;
				lines.push(line);
			}
			const body = lines.join("\n");
			// An unquoted delimiter lets the shell expand $( ) and backticks in the body, which runs them.
			if (!heredoc.quoted) this.substitutionsIn(body);
			heredoc.target.push({ text: body, dialect: "posix" });
		}
	}

	/** Reads '...' from the opening quote at `pos`; PowerShell doubles a quote to escape it. */
	private singleQuoted(): string {
		let out = "";
		this.pos++;
		for (;;) {
			const end = this.text.indexOf("'", this.pos);
			if (end === -1) throw new Unreadable("a single quote is never closed");
			out += this.text.slice(this.pos, end);
			this.pos = end + 1;
			if (this.dialect === "powershell" && this.text[this.pos] === "'") {
				out += "'";
				this.pos++;
			} else return out;
		}
	}

	/** Reads $'...' (ANSI-C quoting) from the quote at `pos`, decoding its backslash escapes. */
	private ansiC(): string {
		let out = "";
		this.pos++;
		while (this.pos < this.text.length && this.text[this.pos] !== "'") {
			const c = this.text[this.pos]!;
			if (c !== "\\") {
				out += c;
				this.pos++;
				continue;
			}
			const e = this.text[this.pos + 1] ?? "";
			const hex = /^x([0-9A-Fa-f]{1,2})/.exec(this.text.slice(this.pos + 1));
			const octal = /^([0-7]{1,3})/.exec(this.text.slice(this.pos + 1));
			if (hex) {
				out += String.fromCharCode(parseInt(hex[1]!, 16));
				this.pos += 1 + hex[0].length;
			} else if (octal) {
				out += String.fromCharCode(parseInt(octal[1]!, 8));
				this.pos += 1 + octal[0].length;
			} else {
				out += ANSI_C[e] ?? `\\${e}`;
				this.pos += 2;
			}
		}
		if (this.pos >= this.text.length) throw new Unreadable("an ANSI-C $' quote is never closed");
		this.pos++;
		return out;
	}

	/** Reads "..." from the opening quote at `pos`, following its substitutions. */
	private doubleQuoted(): string {
		let out = "";
		this.pos++;
		while (this.pos < this.text.length && this.text[this.pos] !== '"') {
			const c = this.text[this.pos]!;
			const next = this.text[this.pos + 1];
			if (c === this.escape && next !== undefined) {
				// POSIX keeps a backslash before an ordinary character; it only escapes " \ $ ` and a newline.
				if (this.dialect === "posix" && !'"\\$`\n'.includes(next)) out += c;
				if (next !== "\n") out += next;
				this.pos += 2;
			} else if (this.dialect === "powershell" && c === '"' && next === '"') {
				out += '"';
				this.pos += 2;
			} else if (this.dialect === "posix" && c === "`") {
				this.backtick();
			} else if (c === "$" && next === "(") {
				this.pos += 2;
				this.nestedHere();
			} else {
				out += c;
				this.pos++;
			}
		}
		if (this.pos >= this.text.length) throw new Unreadable("a double quote is never closed");
		this.pos++;
		return out;
	}

	/** Records each segment's command, and reads as commands the text fed to a shell on standard input. */
	private analyze(segments: Segment[]): void {
		const commands = segments.map((segment) => this.unwrap(segment.words, segment.stdin));
		segments.forEach((segment, k) => {
			const own = commands[k] ? readsCommands(commands[k]!.program) : undefined;
			const piped = segment.pipes && commands[k + 1] ? readsCommands(commands[k + 1]!.program) : undefined;
			const shell = own ?? piped;
			if (shell === undefined) return;
			for (const input of segment.stdin) this.nestedString(input.text, shell);
			// Text echoed into a shell through a pipe is a command too.
			const echoed = commands[k];
			if (piped !== undefined && echoed && ["echo", "printf"].includes(programName(echoed.program))) this.nestedString(echoed.args.join(" "), piped);
		});
		for (const command of commands) if (command) this.found.push(command);
	}

	/** Strips redirections, assignments, keywords, and wrappers, follows the strings they run, and returns the command left. */
	unwrap(all: Word[], stdin: StdinText[]): Invocation | undefined {
		const words: Word[] = [];
		for (let i = 0; i < all.length; i++) {
			const word = all[i]!;
			if (!word.text.startsWith(REDIRECTION)) {
				words.push(word);
				continue;
			}
			// A here-string is standard input; any other redirection's target is a file name.
			if (word.text === `${REDIRECTION}<<<` && i + 1 < all.length) stdin.push({ text: all[i + 1]!.text, dialect: this.dialect });
			i++;
		}
		const texts = words.map((word) => word.text);
		const assignments: string[] = [];
		let i = 0;
		// Each pass consumes at least one word, so this ends within words.length passes.
		while (i < texts.length) {
			const word = texts[i]!;
			const name = programName(word);
			if (ASSIGNMENT.test(word)) {
				assignments.push(word);
				i++;
			} else if (KEYWORDS.has(word)) {
				i++;
			} else if (name === "env") {
				i = this.skipEnv(texts, i + 1, assignments);
			} else if (name === "flock") {
				const at = skipOptions(texts, i + 1, FLOCK_VALUED);
				// flock [options] <file> -c <command>, or flock [options] <file> <command...>
				if (texts[at + 1] === "-c" || texts[at + 1] === "--command") {
					if (at + 2 < texts.length) this.nestedString(texts[at + 2]!);
					return undefined;
				}
				i = at + 1;
			} else if (name === "watch") {
				// watch joins its arguments into one string for sh -c.
				const at = skipOptions(texts, i + 1, WATCH_VALUED);
				if (at < texts.length) this.nestedString(texts.slice(at).join(" "), "posix");
				return undefined;
			} else if (WRAPPERS.has(name)) {
				i = skipOptions(texts, i + 1, WRAPPERS.get(name)!);
				// timeout takes a leading duration operand.
				if (name === "timeout" && i < texts.length && /^\d/.test(texts[i]!)) i++;
			} else {
				break;
			}
		}
		if (i >= texts.length) return undefined;
		const programWord = words[i]!;
		if (programWord.glob && programWord.text !== "[" && programWord.text !== "[[") throw new Unreadable(`its program name ${programWord.text} holds an unquoted glob or brace pattern`);
		// zsh expands =name in command position to the path of name.
		const program = programWord.text.length > 1 && programWord.text.startsWith("=") ? programWord.text.slice(1) : programWord.text;
		const args = texts.slice(i + 1);
		this.followArguments(programName(program), args);
		return { assignments, program, args };
	}

	/** Skips env's options and assignments, reading an -S string as a command; returns the index of its command. */
	private skipEnv(words: string[], start: number, assignments: string[]): number {
		let i = start;
		while (i < words.length && (words[i]!.startsWith("-") || ASSIGNMENT.test(words[i]!))) {
			const option = words[i]!;
			if (ASSIGNMENT.test(option)) {
				assignments.push(option);
				i++;
			} else if (option === "-S" || option === "--split-string") {
				if (i + 1 < words.length) this.nestedString(words[i + 1]!, "posix");
				i += 2;
			} else if (option.startsWith("--split-string=")) {
				this.nestedString(option.slice("--split-string=".length), "posix");
				i++;
			} else if (/^-[^-]*S/.test(option)) {
				// -S attached to its string, possibly after other short flags: -S'git push', -iS'...'.
				this.nestedString(option.slice(option.indexOf("S") + 1), "posix");
				i++;
			} else {
				i += ENV_VALUED.has(option) ? 2 : 1;
			}
		}
		return i;
	}

	/** Reads the command a program runs from its arguments: `sh -c`, `eval`, PowerShell, `cmd /c`, `wsl`, and `find -exec`. */
	private followArguments(name: string, args: string[]): void {
		if (name === "eval" || name === "invoke-expression" || name === "iex") {
			this.nestedString(args.join(" "));
		} else if (SHELLS.has(name)) {
			const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
			if (flag !== -1 && flag + 1 < args.length) this.nestedString(args[flag + 1]!, "posix");
		} else if (POWERSHELLS.has(name)) {
			this.followPowerShell(args);
		} else if (name === "cmd") {
			const flag = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
			if (flag !== -1) this.nestedString(args.slice(flag + 1).join(" "), "posix");
		} else if (name === "wsl") {
			let at = skipOptions(args, 0, WSL_VALUED);
			if (args[at] === "--") at++;
			if (at < args.length) this.nestedString(args.slice(at).join(" "), "posix");
		} else if (name === "find") {
			this.followFindExec(args);
		}
	}

	/** Reads `pwsh -Command <text>` and `pwsh -EncodedCommand <base64 of UTF-16LE>` (and their unambiguous prefixes). */
	private followPowerShell(args: string[]): void {
		for (let i = 0; i < args.length; i++) {
			const option = args[i]!.replace(/^[-/]+/, "").toLowerCase();
			if (!/^[-/]/.test(args[i]!) || option === "") continue;
			if (option === "ec" || (option.startsWith("e") && "encodedcommand".startsWith(option))) {
				this.nestedString(decodePowerShell(args[i + 1] ?? ""), "powershell");
				return;
			}
			if (option === "cwa" || (option.startsWith("c") && ("command".startsWith(option) || "commandwithargs".startsWith(option)))) {
				if (i + 1 < args.length) this.nestedString(args.slice(i + 1).join(" "), "powershell");
				return;
			}
		}
	}

	/** Reads the commands that `find -exec` (and -execdir, -ok, -okdir) runs, up to their `;` or `+`. */
	private followFindExec(args: string[]): void {
		for (let i = 0; i < args.length; i++) {
			if (!FIND_EXEC.has(args[i]!)) continue;
			const end = args.findIndex((arg, at) => at > i && (arg === ";" || arg === "+"));
			const command = args.slice(i + 1, end === -1 ? args.length : end);
			const invocation = this.unwrap(command.map((text) => ({ text, glob: false })), []);
			if (invocation) this.found.push(invocation);
			i = end === -1 ? args.length : end;
		}
	}
}

/** Decodes PowerShell's -EncodedCommand argument; throws Unreadable when it is not base64 of UTF-16LE. */
function decodePowerShell(encoded: string): string {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Unreadable("its -EncodedCommand argument is not base64");
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length % 2 !== 0) throw new Unreadable("its -EncodedCommand argument is not UTF-16LE text");
	return bytes.toString("utf16le");
}

/** Skips options (and the values of `valued` ones) from `start`; returns the index of the first operand. */
function skipOptions(words: string[], start: number, valued: Set<string>): number {
	let i = start;
	while (i < words.length && words[i]!.startsWith("-") && words[i] !== "-") {
		i += valued.has(words[i]!) ? 2 : 1;
	}
	return i;
}
