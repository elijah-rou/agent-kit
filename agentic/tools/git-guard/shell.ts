// Splits a shell command line into the simple commands it would run, for the git guard. It is not a
// shell: it follows common shell syntax (quoting, including ANSI-C $'...' and locale $"...", escapes,
// comments, separators, redirections, here documents and here-strings, command and process
// substitution, arithmetic, parameter expansion, case patterns, array assignments), `sh -c` and `eval`
// strings, commands fed to a shell's standard input, and the wrappers that run another command (`env`,
// `command`, `nohup`, `find -exec`, ...), which is enough to find a git or gh invocation an agent writes.
// Text it cannot read with confidence throws Unreadable, which the guard refuses. What it cannot see (a
// program or arguments that appear only after expansion or evaluation) is listed as a gap in
// claude/README.md.

/** One simple command: its leading NAME=value assignments, the program word, and its arguments, with which arguments hold an unquoted pattern. */
export type Invocation = { assignments: string[]; program: string; args: string[]; patterned: boolean[] };

/** POSIX shells escape with a backslash and substitute with backticks; PowerShell escapes with a backtick. */
export type Dialect = "posix" | "powershell";

/** Thrown for a command the reader cannot read with confidence; the guard refuses such a command. */
export class Unreadable extends Error {}

/** Command substitutions, subshells, shell strings, and fed here documents are followed this many levels deep. */
export const NESTING_LIMIT = 8;

/** A word, whether it holds an unquoted glob or brace character (a pattern), and whether any of it was quoted. */
type Word = { text: string; glob: boolean; quoted: boolean };
/** A simple command's words, the text on its standard input (here documents and here-strings), and whether it pipes into the next. */
type Segment = { words: Word[]; stdin: StdinText[]; pipes: boolean };
type StdinText = { text: string };
type PendingHeredoc = { delimiter: string; stripTabs: boolean; quoted: boolean; target: StdinText[] };

// A word holding a redirection operator starts with this character, which no command text produces.
const REDIRECTION = "\u0000";
// The placeholder a process substitution leaves in its word, so a shell given one as its script is seen.
const PROCESS_SUBSTITUTION = "\u0001<(...)";
const GLOB = /[*?[{}]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;
// Words that may precede a command without being it (shell keywords, and zsh's precommand modifiers).
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "-", "nocorrect", "coproc"]);
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
	xcrun: new Set(["-sdk", "--sdk", "--toolchain"]),
}));
const ENV_VALUED = new Set(["-u", "--unset", "-C", "--chdir", "-P"]);
const FLOCK_VALUED = new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]);
const WATCH_VALUED = new Set(["-n", "--interval", "-q", "--equexit", "-s", "--shell"]);
const WSL_VALUED = new Set(["-d", "--distribution", "-u", "--user", "--cd", "--shell-type", "--distribution-id"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
// Shell options that take the next word as their value.
const SHELL_VALUED = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
// PowerShell's command-line parameters (pwsh 7 and Windows PowerShell 5.1): full name, documented
// aliases, and what the parameter does with the words after it. Any other unambiguous prefix of a full
// name also names it.
type PowerShellKind = "command" | "encoded" | "file" | "value" | "flag";
const POWERSHELL_PARAMETERS: [string, string[], PowerShellKind][] = [
	["command", ["c"], "command"],
	["commandwithargs", ["cwa"], "command"],
	["encodedcommand", ["e", "ec"], "encoded"],
	["file", ["f"], "file"],
	["configurationfile", [], "value"],
	["configurationname", ["config"], "value"],
	["custompipename", [], "value"],
	["executionpolicy", ["ex", "ep"], "value"],
	["inputformat", ["inp", "if"], "value"],
	["outputformat", ["o", "of"], "value"],
	["psconsolefile", [], "value"],
	["settingsfile", ["settings"], "value"],
	["version", ["v"], "value"],
	["windowstyle", ["w"], "value"],
	["workingdirectory", ["wd"], "value"],
	["interactive", ["i"], "flag"],
	["login", ["l"], "flag"],
	["mta", [], "flag"],
	["sta", [], "flag"],
	["noexit", ["noe"], "flag"],
	["nologo", ["nol"], "flag"],
	["noninteractive", ["noni"], "flag"],
	["noprofile", ["nop"], "flag"],
	["noprofileloadtime", [], "flag"],
	["sshservermode", ["sshs"], "flag"],
	["help", ["?", "h"], "flag"],
];

/** What a PowerShell dash word names: an exact alias or full name, else the one full name it prefixes; Unreadable when it prefixes several. */
function powerShellParameter(option: string): PowerShellKind | undefined {
	const exact = POWERSHELL_PARAMETERS.find(([full, aliases]) => full === option || aliases.includes(option));
	if (exact) return exact[2];
	const matches = POWERSHELL_PARAMETERS.filter(([full]) => full.startsWith(option));
	if (matches.length > 1 && new Set(matches.map(([, , kind]) => kind)).size > 1) throw new Unreadable(`its PowerShell option -${option} is ambiguous between ${matches.map(([full]) => `-${full}`).join(", ")}`);
	return matches[0]?.[2];
}
const INVOKE_EXPRESSION = new Set(["eval", "invoke-expression", "iex"]);
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

/** How a shell invocation treats text: its standard input as commands, an operand that is another command's output, or neither. */
type ShellInput = { kind: "stdin"; dialect: Dialect } | { kind: "output-as-script" } | undefined;

class Reader {
	private pos = 0;
	private readonly escape: string;

	/**
	 * `inherited` holds the assignments in force for every command this text runs, because the text is a
	 * string a program runs with them in its environment (`HUSKY=0 sh -c '...'`).
	 */
	constructor(private readonly text: string, private readonly dialect: Dialect, private readonly depth: number, private readonly found: Invocation[], private readonly inherited: string[] = []) {
		if (depth > NESTING_LIMIT) throw new Unreadable(`it nests more than ${NESTING_LIMIT} levels of substitution, subshell, or shell string`);
		this.escape = dialect === "posix" ? "\\" : "`";
	}

	/** Reads the whole text as a command list and records every invocation in it. */
	run(): void {
		this.analyze(this.list(undefined));
	}

	/** Reads text nested inside this text (a substitution or subshell) from `pos` up to its `)`, as commands. */
	private nestedHere(): void {
		const inner = new Reader(this.text, this.dialect, this.depth + 1, this.found, this.inherited);
		inner.pos = this.pos;
		inner.analyze(inner.list(")"));
		this.pos = inner.pos;
	}

	/** Reads a separate string as commands, such as an `sh -c` argument or a here document fed to a shell. */
	nestedString(text: string, dialect: Dialect = this.dialect, carry: string[] = this.inherited): void {
		new Reader(text, dialect, this.depth + 1, this.found, carry).run();
	}

	/** Records the substitutions in text a shell expands but does not run, such as an unquoted here document body. */
	private substitutionsIn(text: string): void {
		const inner = new Reader(text, "posix", this.depth + 1, this.found, this.inherited);
		while (inner.pos < text.length) {
			const c = text[inner.pos]!;
			if (c === "\\") inner.pos += 2;
			else if (c === "`") inner.backtick();
			else if (c === "$" && text[inner.pos + 1] === "(") inner.dollarParen();
			// An unquoted here document body expands like a double-quoted string.
			else if (c === "$" && text[inner.pos + 1] === "{") inner.parameter(true);
			else inner.pos++;
		}
	}

	/** Reads `...` from the opening backtick at `pos` and its command. */
	private backtick(): void {
		let end = this.pos + 1;
		while (end < this.text.length && this.text[end] !== "`") end += this.text[end] === "\\" ? 2 : 1;
		if (end >= this.text.length) throw new Unreadable("a backtick substitution is never closed");
		this.nestedString(this.text.slice(this.pos + 1, end).replace(/\\([`\\$])/g, "$1"));
		this.pos = end + 1;
	}

	/**
	 * Index of the `)` that closes the inner `(` of `$((` or `((` at `open` (the first `(`), or -1. As bash
	 * and zsh decide, the text is arithmetic only when that `)` is followed at once by the final `)`.
	 */
	private arithmeticEnd(open: number): number {
		let depth = 0;
		for (let i = open + 2; i < this.text.length; i++) {
			const c = this.text[i]!;
			if (c === "\\") i++;
			else if (c === "(") depth++;
			else if (c === ")") {
				if (depth === 0) return this.text[i + 1] === ")" ? i : -1;
				depth--;
			}
		}
		return -1;
	}

	/** Reads `$(` at `pos`: arithmetic `$(( ))` as text whose substitutions are commands, otherwise a command substitution. */
	private dollarParen(): string {
		if (this.dialect === "posix" && this.text[this.pos + 2] === "(") {
			const end = this.arithmeticEnd(this.pos + 1);
			if (end !== -1) return this.arithmetic(this.pos + 3, end, this.pos);
		}
		this.pos += 2;
		this.nestedHere();
		return "$(...)";
	}

	/** Reads arithmetic text from `start` to `end` (the inner `)`), following $( ), backticks, and ${ }; returns the text from `from`. */
	private arithmetic(start: number, end: number, from: number): string {
		this.pos = start;
		while (this.pos < end) {
			const c = this.text[this.pos]!;
			if (c === "`") this.backtick();
			else if (c === "$" && this.text[this.pos + 1] === "(") this.dollarParen();
			else if (c === "$" && this.text[this.pos + 1] === "{") this.parameter();
			else this.pos++;
		}
		this.pos = end + 2;
		return this.text.slice(from, this.pos);
	}

	/**
	 * Reads ${...} from `pos`, matching braces past quotes and substitutions, and follows the substitutions
	 * inside. Inside double quotes, a single quote in ${...} is an ordinary character and does not quote.
	 */
	private parameter(inDoubleQuotes = false): string {
		const start = this.pos;
		this.pos += 2;
		let depth = 0;
		while (this.pos < this.text.length) {
			const c = this.text[this.pos]!;
			if (c === "\\") this.pos += 2;
			else if (c === "'" && !inDoubleQuotes) this.singleQuoted();
			else if (c === "'") this.quoteInDoubleQuotedParameter();
			else if (c === '"') this.doubleQuoted();
			else if (c === "`") this.backtick();
			else if (c === "$" && this.text[this.pos + 1] === "(") this.dollarParen();
			else if (c === "$" && this.text[this.pos + 1] === "{") {
				this.pos += 2;
				depth++;
			} else if (c === "}") {
				this.pos++;
				if (depth === 0) return this.text.slice(start, this.pos);
				depth--;
			} else this.pos++;
		}
		throw new Unreadable("a ${ parameter expansion is never closed");
	}

	/**
	 * Reads a ' inside a double-quoted ${...}. bash in its default mode skips a single-quoted span there
	 * when it looks for the closing }, while zsh and POSIX-mode bash read the quote as an ordinary
	 * character. The reader follows any substitution in the span, which both run, and refuses a span
	 * holding } or ", where the shells end the expansion in different places.
	 */
	private quoteInDoubleQuotedParameter(): void {
		const end = this.text.indexOf("'", this.pos + 1);
		const span = end === -1 ? this.text.slice(this.pos + 1) : this.text.slice(this.pos + 1, end);
		if (end === -1 || /[}"]/.test(span)) throw new Unreadable("a single quote inside a double-quoted ${...} is read differently by bash and zsh");
		this.substitutionsIn(span);
		this.pos = end + 1;
	}

	/** Reads an array assignment's ( ... ) from `pos` as text, following its quotes and substitutions. */
	private arrayLiteral(): string {
		const start = this.pos;
		this.pos++;
		while (this.pos < this.text.length) {
			const c = this.text[this.pos]!;
			if (c === ")") {
				this.pos++;
				return this.text.slice(start, this.pos);
			}
			if (c === "\\") this.pos += 2;
			else if (c === "'") this.singleQuoted();
			else if (c === '"') this.doubleQuoted();
			else if (c === "`") this.backtick();
			else if (c === "$" && this.text[this.pos + 1] === "(") this.dollarParen();
			else if (c === "$" && this.text[this.pos + 1] === "{") this.parameter();
			else this.pos++;
		}
		throw new Unreadable("an array assignment's ( is never closed");
	}

	/** Skips a case pattern (an optional `(`, then up to its unquoted `)`); returns false at `esac` instead. */
	private casePattern(): boolean {
		// Skip blank space and whole-line # comments between clauses.
		for (;;) {
			while (this.pos < this.text.length && " \t\r\n".includes(this.text[this.pos]!)) this.pos++;
			if (this.text[this.pos] !== "#") break;
			const end = this.text.indexOf("\n", this.pos);
			this.pos = end === -1 ? this.text.length : end;
		}
		if (/^esac(?=$|[\s;&|)])/.test(this.text.slice(this.pos))) {
			this.pos += 4;
			return false;
		}
		if (this.text[this.pos] === "(") this.pos++;
		let depth = 0;
		while (this.pos < this.text.length) {
			const c = this.text[this.pos]!;
			if (c === "\\") this.pos += 2;
			else if (c === "'") this.singleQuoted();
			else if (c === '"') this.doubleQuoted();
			else if (c === "$" && this.text[this.pos + 1] === "(") this.dollarParen();
			else if (c === "(") {
				depth++;
				this.pos++;
			} else if (c === ")") {
				this.pos++;
				if (depth === 0) return true;
				depth--;
			} else this.pos++;
		}
		throw new Unreadable("a case pattern is never closed with )");
	}

	/** Splits commands until `closer` or the end, reading quotes, substitutions, redirections, here documents, and case patterns. */
	private list(closer: ")" | undefined): Segment[] {
		const segments: Segment[] = [];
		let words: Word[] = [];
		let stdin: StdinText[] = [];
		let word: Word | undefined;
		const pending: PendingHeredoc[] = [];
		// Open case statements, and whether the next text is a pattern rather than a command.
		let cases = 0;
		let expectPattern = false;
		const append = (s: string, flags: { glob?: boolean; quoted?: boolean } = {}) => {
			word = { text: (word?.text ?? "") + s, glob: (word?.glob ?? false) || (flags.glob ?? false), quoted: (word?.quoted ?? false) || (flags.quoted ?? false) };
		};
		const endWord = () => {
			if (word === undefined) return;
			if (word.text === "esac" && !word.quoted && words.length === 0 && cases > 0) cases--;
			else words.push(word);
			word = undefined;
			// `case <word> in` at command position (after any keywords such as do or then) opens a case.
			const at = words.length - 3;
			if (at >= 0 && words[at]!.text === "case" && words[at + 2]!.text === "in" && !words[at + 2]!.quoted && words.slice(0, at).every((before) => KEYWORDS.has(before.text))) {
				cases++;
				expectPattern = true;
				words = [];
			}
		};
		const endSegment = (pipes: boolean) => {
			endWord();
			if (words.length || stdin.length) segments.push({ words, stdin, pipes });
			words = [];
			stdin = [];
		};
		const text = this.text;
		while (this.pos < text.length) {
			if (expectPattern) {
				expectPattern = false;
				if (!this.casePattern()) cases--;
				continue;
			}
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
				if (next !== undefined && next !== "\n") append(next, { quoted: true });
				this.pos += 2;
			} else if (c === "'") {
				append(this.singleQuoted(), { quoted: true });
			} else if (this.dialect === "posix" && c === "$" && next === "'") {
				this.pos++;
				append(this.ansiC(), { quoted: true });
			} else if (this.dialect === "posix" && c === "$" && next === '"') {
				// $"..." is bash's locale-translated string: a double-quoted string.
				this.pos++;
				append(this.doubleQuoted(), { quoted: true });
			} else if (c === "$" && next === "{") {
				append(this.parameter());
			} else if (c === '"') {
				append(this.doubleQuoted(), { quoted: true });
			} else if (this.dialect === "posix" && c === "`") {
				this.backtick();
				append("`...`");
			} else if (c === "$" && next === "(") {
				append(this.dollarParen());
			} else if ((c === "<" || c === ">") && next === "(") {
				this.pos += 2;
				this.nestedHere();
				append(c === "<" ? PROCESS_SUBSTITUTION : ">(...)");
			} else if (this.dialect === "posix" && c === "(" && word !== undefined && ARRAY_ASSIGNMENT.test(word.text)) {
				append(this.arrayLiteral());
			} else if (this.dialect === "posix" && c === "(" && next === "(" && word === undefined && this.arithmeticEnd(this.pos) !== -1) {
				// (( ... )) is an arithmetic command.
				append(this.arithmetic(this.pos + 2, this.arithmeticEnd(this.pos), this.pos));
			} else if (c === "(") {
				endSegment(false);
				this.pos++;
				this.nestedHere();
			} else if (c === ")" || (this.dialect === "powershell" && (c === "{" || c === "}"))) {
				endSegment(false);
				this.pos++;
			} else if (this.dialect === "powershell" && c === "<" && next === "#") {
				const end = text.indexOf("#>", this.pos + 2);
				if (end === -1) throw new Unreadable("a <# block comment is never closed");
				this.pos = end + 2;
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
				words.push({ text: REDIRECTION + this.redirection(), glob: false, quoted: false });
			} else if (c === ";" || c === "&" || c === "|") {
				const pipes = c === "|" && next !== "|";
				endSegment(pipes);
				const operator = /^(;;&|;;|;&|&&|\|\||\|&|;|&|\|)/.exec(text.slice(this.pos))![0];
				this.pos += operator.length;
				if (cases > 0 && operator.startsWith(";") && operator.length > 1) expectPattern = true;
			} else if (c === " " || c === "\t" || c === "\r") {
				endWord();
				this.pos++;
			} else {
				append(c, { glob: this.dialect === "posix" && GLOB.test(c) });
				this.pos++;
			}
		}
		endSegment(false);
		if (closer !== undefined) throw new Unreadable("a $( or ( is never closed");
		if (pending.length) throw new Unreadable(`a here document (${pending[0]!.delimiter}) is never closed`);
		return segments;
	}

	/** Reads a redirection operator at `pos` (>, >>, >|, >!, >&, <, <&, <>, <<<, &>, &>>) and returns it. */
	private redirection(): string {
		const start = this.pos;
		if (this.text[this.pos] === "&") this.pos++;
		while (this.pos - start < 4 && (this.text[this.pos] === ">" || this.text[this.pos] === "<")) this.pos++;
		if (this.text[this.pos] === "&" || this.text[this.pos] === "|" || (this.dialect === "posix" && this.text[this.pos] === "!")) this.pos++;
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
			heredoc.target.push({ text: body });
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
			const rest = this.text.slice(this.pos + 1);
			const code = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/.exec(rest);
			if (code) {
				const [digits, base] = code[1] ? [code[1], 16] : code[2] ? [code[2], 16] : code[3] ? [code[3], 16] : [code[4]!, 8];
				out += String.fromCodePoint(Math.min(parseInt(digits, base), 0x10ffff));
				this.pos += 1 + code[0].length;
			} else {
				const e = rest[0] ?? "";
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
				out += this.dollarParen();
			} else if (this.dialect === "posix" && c === "$" && next === "{") {
				out += this.parameter(true);
			} else {
				out += c;
				this.pos++;
			}
		}
		if (this.pos >= this.text.length) throw new Unreadable("a double quote is never closed");
		this.pos++;
		return out;
	}

	/** Records each segment's command, and reads as commands what a shell reads as commands from its input. */
	private analyze(segments: Segment[]): void {
		const commands = segments.map((segment) => this.unwrap(segment.words, segment.stdin));
		segments.forEach((segment, k) => {
			const command = commands[k];
			if (!command) return;
			const input = this.shellInput(command);
			if (input === undefined) return;
			if (input.kind === "output-as-script") throw new Unreadable("it runs another command's output as a script");
			this.readFedInput(segments, commands, k, input.dialect);
		});
		for (const command of commands) if (command) this.found.push(command);
	}

	/**
	 * Reads the commands fed to the stdin-reading shell at segment k: its own here document or here-string,
	 * or one fed by `cat <<EOF |` (or, for PowerShell, a literal string piped into it). Anything else feeding
	 * it, including another command's output, is unreadable.
	 */
	private readFedInput(segments: Segment[], commands: (Invocation | undefined)[], k: number, dialect: Dialect): void {
		const own = segments[k]!.stdin;
		if (own.length) {
			for (const input of own) this.nestedString(input.text, dialect, commands[k]!.assignments);
			return;
		}
		const piped = k > 0 && segments[k - 1]!.pipes;
		if (!piped) throw new Unreadable("it starts a shell that reads commands from its input, which the guard cannot see; pass the commands with -c, or in a quoted here document, instead");
		const producer = commands[k - 1];
		const producerSegment = segments[k - 1];
		if (producer && producerSegment && programName(producer.program) === "cat" && producer.args.length === 0 && producerSegment.stdin.length) {
			for (const input of producerSegment.stdin) this.nestedString(input.text, dialect, commands[k]!.assignments);
			return;
		}
		if (producer && producerSegment && producer.program !== "" && dialect === "powershell") {
			const words = producerSegment.words.filter((word) => !word.text.startsWith(REDIRECTION));
			const literal = words.length === 1 && words[0]!.quoted ? words[0]!.text : ["echo", "write-output"].includes(programName(producer.program)) && words.slice(1).every((word) => word.quoted) ? producer.args.join(" ") : undefined;
			if (literal !== undefined) {
				this.nestedString(literal, "powershell", commands[k]!.assignments);
				return;
			}
		}
		throw new Unreadable("it feeds a shell commands from another command's output; pass them with -c, or in a quoted here document, instead");
	}

	/** Whether an invocation reads its standard input as commands (a shell without a script, or Invoke-Expression without a string), or runs another command's output as its script. */
	private shellInput(command: Invocation): ShellInput {
		const name = programName(command.program);
		const { args } = command;
		if (name === "source" || name === ".") {
			if (args[0] === PROCESS_SUBSTITUTION) return { kind: "output-as-script" };
			return args[0] === "/dev/stdin" || args[0] === "-" ? { kind: "stdin", dialect: "posix" } : undefined;
		}
		if (SHELLS.has(name)) {
			const { commandMode, operand, readsStdin } = shellArgs(name, args);
			if (commandMode || args.includes("--version") || args.includes("--help")) return undefined;
			if (operand === PROCESS_SUBSTITUTION) return { kind: "output-as-script" };
			return readsStdin || operand === undefined || operand === "-" || operand === "/dev/stdin" ? { kind: "stdin", dialect: "posix" } : undefined;
		}
		if (POWERSHELLS.has(name)) {
			if (args.length === 0) return { kind: "stdin", dialect: "powershell" };
			const at = args.findIndex((arg) => /^[-/](c|co|com|comm|comma|comman|command|f|fi|fil|file)$/i.test(arg));
			return at !== -1 && args[at + 1] === "-" ? { kind: "stdin", dialect: "powershell" } : undefined;
		}
		if (name === "invoke-expression" || name === "iex") return args.length === 0 ? { kind: "stdin", dialect: "powershell" } : undefined;
		return undefined;
	}

	/** Strips redirections, assignments, keywords, and wrappers, follows the strings they run, and returns the command left. */
	unwrap(all: Word[], stdin: StdinText[], base: string[] = this.inherited): Invocation | undefined {
		const words: Word[] = [];
		for (let i = 0; i < all.length; i++) {
			const word = all[i]!;
			if (!word.text.startsWith(REDIRECTION)) {
				words.push(word);
				continue;
			}
			// A here-string is standard input; any other redirection's target is a file name.
			if (word.text === `${REDIRECTION}<<<` && i + 1 < all.length) stdin.push({ text: all[i + 1]!.text });
			i++;
		}
		const texts = words.map((word) => word.text);
		// The environment this command runs with: what its text inherits, then its own assignments.
		const assignments: string[] = [...base];
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
			} else if (word === "repeat" && i + 1 < texts.length) {
				// zsh: repeat <count> <command>
				i += 2;
			} else if (name === "env") {
				i = this.skipEnv(texts, i + 1, assignments);
			} else if (name === "flock") {
				const at = skipOptions(texts, i + 1, FLOCK_VALUED);
				// flock [options] <file> -c <command>, or flock [options] <file> <command...>
				if (texts[at + 1] === "-c" || texts[at + 1] === "--command") {
					if (at + 2 < texts.length) this.nestedString(texts[at + 2]!, this.dialect, assignments);
					return undefined;
				}
				i = at + 1;
			} else if (name === "watch") {
				// watch joins its arguments into one string for sh -c.
				const at = skipOptions(texts, i + 1, WATCH_VALUED);
				if (at < texts.length) this.nestedString(texts.slice(at).join(" "), "posix", assignments);
				return undefined;
			} else if (WRAPPERS.has(name)) {
				i = skipOptions(texts, i + 1, WRAPPERS.get(name)!);
				// timeout takes a leading duration operand.
				if (name === "timeout" && i < texts.length && /^\d/.test(texts[i]!)) i++;
			} else {
				break;
			}
		}
		// A command of assignments alone still sets them in the shell, which the policy reads.
		if (i >= texts.length) return assignments.length > base.length ? { assignments, program: "", args: [], patterned: [] } : undefined;
		const programWord = words[i]!;
		if (programWord.glob && programWord.text !== "[" && programWord.text !== "[[") throw new Unreadable(`its program name ${programWord.text} holds an unquoted glob or brace pattern`);
		// zsh expands =name in command position to the path of name.
		let program = programWord.text.length > 1 && programWord.text.startsWith("=") ? programWord.text.slice(1) : programWord.text;
		let args = texts.slice(i + 1);
		let patterned = words.slice(i + 1).map((word) => word.glob);
		// git's own git-<subcommand> programs (libexec/git-core/git-push) are git with that subcommand.
		const dashed = /^git-([a-z][a-z0-9-]*)$/.exec(programName(program));
		if (dashed) {
			program = "git";
			args = [dashed[1]!, ...args];
			patterned = [false, ...patterned];
		}
		this.followArguments(programName(program), args, assignments);
		return { assignments, program, args, patterned };
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
				if (i + 1 < words.length) this.nestedString(words[i + 1]!, "posix", assignments);
				i += 2;
			} else if (option.startsWith("--split-string=")) {
				this.nestedString(option.slice("--split-string=".length), "posix", assignments);
				i++;
			} else if (/^-[^-]*S/.test(option)) {
				// -S attached to its string, possibly after other short flags: -S'git push', -iS'...'.
				this.nestedString(option.slice(option.indexOf("S") + 1), "posix", assignments);
				i++;
			} else {
				i += ENV_VALUED.has(option) ? 2 : 1;
			}
		}
		return i;
	}

	/** Reads the command a program runs from its arguments: `sh -c`, `fish -c`, `eval`, PowerShell, `cmd /c`, `wsl`, and `find -exec`. */
	private followArguments(name: string, args: string[], carry: string[]): void {
		if (INVOKE_EXPRESSION.has(name)) {
			// eval [--] <words>; Invoke-Expression [-Command] <string>, where -Command (or a prefix) can only come first.
			const leading = name === "eval" ? args[0] === "--" : /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(args[0] ?? "");
			const rest = leading ? args.slice(1) : args;
			if (rest.length) this.nestedString(rest.join(" "), this.dialect, carry);
		} else if (SHELLS.has(name)) {
			const { commandMode, operand } = shellArgs(name, args);
			if (commandMode && operand !== undefined) this.nestedString(operand, "posix", carry);
		} else if (POWERSHELLS.has(name)) {
			this.followPowerShell(name, args, carry);
		} else if (name === "cmd") {
			const flag = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
			if (flag !== -1) this.nestedString(args.slice(flag + 1).join(" "), "posix", carry);
		} else if (name === "wsl") {
			let at = skipOptions(args, 0, WSL_VALUED);
			if (args[at] === "--") at++;
			if (at < args.length) this.nestedString(args.slice(at).join(" "), "posix", carry);
		} else if (name === "find") {
			this.followFindExec(args, carry);
		} else if (name === "git") {
			// git submodule foreach [--recursive] <command> runs its command through a shell in each submodule.
			const at = args.findIndex((arg, i) => arg === "foreach" && args[i - 1] === "submodule");
			if (at !== -1) {
				const command = skipOptions(args, at + 1, new Set());
				if (command < args.length) this.nestedString(args.slice(command).join(" "), "posix", carry);
			}
		}
	}

	/**
	 * Reads `pwsh -Command <text>`, `-EncodedCommand <base64 of UTF-16LE>` (and their unambiguous
	 * prefixes), and Windows PowerShell's positional command (`powershell "git push"`).
	 */
	private followPowerShell(name: string, args: string[], carry: string[]): void {
		const dash = (word: string | undefined) => word !== undefined && /^[-/]/.test(word) && word !== "-";
		for (let i = 0; i < args.length; i++) {
			const arg = args[i]!;
			if (!dash(arg)) {
				// powershell.exe reads a first positional word as -Command; pwsh reads it as -File.
				if (name === "powershell") this.nestedString(args.slice(i).join(" "), "powershell", carry);
				return;
			}
			const kind = powerShellParameter(arg.replace(/^[-/]+/, "").toLowerCase());
			if (kind === "encoded") {
				this.nestedString(decodePowerShell(args[i + 1] ?? ""), "powershell", carry);
				return;
			}
			if (kind === "command") {
				if (i + 1 < args.length && args[i + 1] !== "-") this.nestedString(args.slice(i + 1).join(" "), "powershell", carry);
				return;
			}
			// -File <script> [args]: the rest is the script's.
			if (kind === "file") return;
			// A value option consumes the next word. When that word also names -Command, -EncodedCommand, or
			// -File (`-wd /c`, `-wd -c`), pwsh takes it as the value, but a reader that chose either meaning
			// could be wrong about the rest, so the command is unreadable.
			if (kind === "value") {
				const next = args[i + 1];
				if (dash(next) && ["command", "encoded", "file"].includes(powerShellParameter(next!.replace(/^[-/]+/, "").toLowerCase()) ?? "")) {
					throw new Unreadable(`its PowerShell option ${arg} takes ${next} as a value, which also names an option that runs a command`);
				}
				i++;
			}
		}
	}

	/** Reads the commands that `find -exec` (and -execdir, -ok, -okdir) runs, up to their `;` or `+`. */
	private followFindExec(args: string[], carry: string[]): void {
		for (let i = 0; i < args.length; i++) {
			if (!FIND_EXEC.has(args[i]!)) continue;
			const end = args.findIndex((arg, at) => at > i && (arg === ";" || arg === "+"));
			const command = args.slice(i + 1, end === -1 ? args.length : end);
			// The command runs with find's environment, so it starts from find's assignments.
			const invocation = this.unwrap(command.map((text) => ({ text, glob: false, quoted: false })), [], carry);
			if (invocation) this.found.push(invocation);
			i = end === -1 ? args.length : end;
		}
	}
}

/**
 * Reads a shell's arguments: whether it runs a command string (-c, or fish's --command and -C), the
 * first operand (that string, or the script), and whether -s makes it read commands from stdin.
 */
function shellArgs(name: string, args: string[]): { commandMode: boolean; operand: string | undefined; readsStdin: boolean } {
	let commandMode = false;
	let readsStdin = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") return { commandMode, operand: args[i + 1], readsStdin };
		if (name === "fish" && /^--(command|init-command)=/.test(arg)) return { commandMode: true, operand: arg.slice(arg.indexOf("=") + 1), readsStdin };
		if (name === "fish" && (arg === "--command" || arg === "--init-command")) return { commandMode: true, operand: args[i + 1], readsStdin };
		if (SHELL_VALUED.has(arg)) {
			i++;
			continue;
		}
		if (/^[-+][A-Za-z]+$/.test(arg)) {
			if (/c/.test(arg) || (name === "fish" && /C/.test(arg))) commandMode = true;
			if (/s/.test(arg)) readsStdin = true;
			// A cluster ending in o or O takes the next word as its option name: bash -euo pipefail.
			if (name !== "fish" && /[oO]$/.test(arg)) i++;
			continue;
		}
		if (arg.startsWith("--")) continue;
		return { commandMode, operand: arg, readsStdin };
	}
	return { commandMode, operand: undefined, readsStdin };
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
