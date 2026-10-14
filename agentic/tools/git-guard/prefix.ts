// Finds each git or gh that a run of assignments hides from classify.ts's patterns (GIT_EDITOR=true git
// commit --no-verify), which see git only at the start of a line or after ;, &, or |. One left-to-right
// pass over the text reads it as a shell lexer would, far enough to know where a command starts and where
// each word ends: quotes, $'...', backslash escapes and line continuations, $(...), $((...)), backquotes,
// ${...}, redirections, comments, and here documents. It is not a parser: it builds no syntax tree and reads no
// grammar beyond a command's leading assignments and the few reserved words that start a command.
//
// The result only ever adds refusals: classify.ts denies when its patterns deny the text as written, or
// the lifted text: the same text with a newline inserted before each such git or gh, and with each
// backslash-newline outside single quotes and here documents removed, as bash joins those lines. A text the
// lexer cannot finish (a quote or here-document delimiter with no end) stops the scan there and lifts
// nothing past that point; bash refuses to run such a command, so nothing hidden in it runs.

/** The text with each assignment-prefixed git or gh lifted to the start of its own line. */
export type Lift = {
	/** The text with a newline inserted before each git or gh that follows a run of assignments and its line continuations joined; the text itself when there are neither. */
	text: string;
	/** True when a run of assignments before a git or gh assigns one of the flagged names (a hook manager's skip variable). */
	flagged: boolean;
	/** Characters the lexer examined, for the test that holds the scan to linear work. */
	steps: number;
};

type CommandFrame = {
	kind: "command";
	/** What ends this command list: ) for $(...) or a subshell, a backquote, or nothing at the top level. */
	closer: ")" | "`" | undefined;
	/** The next word may be an assignment or the command's name. */
	atStart: boolean;
	/** Where the run of assignments before the command's name began, or -1. */
	runStart: number;
	runFlagged: boolean;
	/** Where the current word began, or -1 between words. */
	wordStart: number;
	/** The current word holds only characters that stand for themselves: no quote, escape, $, backquote, or parenthesis. */
	wordPlain: boolean;
	/** The name the current word assigns, when it is an assignment at a command's start. */
	wordName: string | undefined;
	/** The next word is a redirection's target, not part of the command. */
	redirectTarget: boolean;
};
/** $((...)): parentheses nest, and < or > is an operator, never a redirection or a here document. */
type ArithmeticFrame = { kind: "arithmetic"; depth: number };
type Frame = CommandFrame | ArithmeticFrame | { kind: "double" } | { kind: "brace"; quoted: boolean };

/** Words that leave the word after them at a command's start. */
const RESERVED = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until", "time"]);
const NAME_START = /[A-Za-z_]/;
const NAME_PART = /\w/;
const DELIMITER_END = /[\s;&|<>()]/;

const commandFrame = (closer: CommandFrame["closer"]): CommandFrame => ({ kind: "command", closer, atStart: true, runStart: -1, runFlagged: false, wordStart: -1, wordPlain: false, wordName: undefined, redirectTarget: false });

/** True when the plain word text[start, end) is git or gh by name or absolute path, as classify.ts's `program` matches them. */
function isGitOrGh(text: string, start: number, end: number): boolean {
	for (const name of ["git", "gh"]) {
		if (end - start === name.length && text.startsWith(name, start)) return true;
		if (text[start] === "/" && text.endsWith(`/${name}`, end)) return true;
	}
	return false;
}

/** Lifts each git or gh that follows a run of assignments in command position; `flagged` names the variables that mark a run. */
export function liftAssignedCommands(text: string, flagged: ReadonlySet<string>): Lift {
	const lifts: number[] = [];
	// Where each backslash-newline that bash removes starts.
	const joins: number[] = [];
	let runFlaggedHit = false;
	let steps = 0;
	const stack: Frame[] = [commandFrame(undefined)];
	const heredocs: { delimiter: string; tabs: boolean }[] = [];

	/** Starts a word at `at` unless one is under way; `plain` says whether the character stands for itself. */
	const beginWord = (frame: CommandFrame, at: number, plain = false) => {
		if (frame.wordStart >= 0) {
			frame.wordPlain &&= plain;
			return;
		}
		frame.wordStart = at;
		frame.wordPlain = plain;
		frame.wordName = undefined;
		if (!frame.atStart || frame.redirectTarget || !NAME_START.test(text[at]!)) return;
		let end = at + 1;
		while (end < text.length && NAME_PART.test(text[end]!)) end++;
		steps += end - at;
		const equals = text[end] === "+" ? end + 1 : end;
		if (text[equals] === "=") frame.wordName = text.slice(at, end);
	};

	const endWord = (frame: CommandFrame, at: number, beforeRedirect = false) => {
		const start = frame.wordStart;
		if (start < 0) return;
		frame.wordStart = -1;
		if (frame.redirectTarget) {
			frame.redirectTarget = false;
			return;
		}
		if (!frame.atStart) return;
		if (frame.wordName !== undefined) {
			if (frame.runStart < 0) frame.runStart = start;
			if (flagged.has(frame.wordName)) frame.runFlagged = true;
			frame.wordName = undefined;
			return;
		}
		// Only a plain word can be git, gh, a reserved word, or a file descriptor, and only a short one is
		// read again, so no character is read once per enclosing word.
		const short = frame.wordPlain && at - start <= 5 ? text.slice(start, at) : undefined;
		steps += short?.length ?? 1;
		// A file descriptor before a redirection (2>/dev/null) is not the command's name.
		if (beforeRedirect && short !== undefined && /^\d+$/.test(short)) return;
		if (frame.runStart >= 0 && frame.wordPlain && isGitOrGh(text, start, at)) {
			lifts.push(start);
			runFlaggedHit ||= frame.runFlagged;
		} else if (frame.runStart < 0 && short !== undefined && RESERVED.has(short)) return;
		frame.atStart = false;
		frame.runStart = -1;
		frame.runFlagged = false;
	};

	const separate = (frame: CommandFrame) => {
		frame.atStart = true;
		frame.runStart = -1;
		frame.runFlagged = false;
		frame.redirectTarget = false;
	};

	/** The end of a $'...' string whose body starts at `from`, or -1 when it has none. */
	const ansiEnd = (from: number): number => {
		for (let at = from; at < text.length; at++) {
			steps++;
			if (text[at] === "\\") at++;
			else if (text[at] === "'") return at;
		}
		return -1;
	};

	/** A here document's delimiter word starting at `from` with its quotes removed, and where it ends; undefined when a quote in it has no end. */
	const readDelimiter = (from: number): { delimiter: string; end: number } | undefined => {
		let delimiter = "";
		let at = from;
		while (at < text.length && !DELIMITER_END.test(text[at]!)) {
			steps++;
			const c = text[at]!;
			if (c === "'") {
				const close = text.indexOf("'", at + 1);
				if (close < 0) return undefined;
				steps += close - at;
				delimiter += text.slice(at + 1, close);
				at = close + 1;
			} else if (c === '"') {
				at++;
				while (at < text.length && text[at] !== '"') {
					steps++;
					if (text[at] === "\\") at++;
					delimiter += text[at] ?? "";
					at++;
				}
				if (at >= text.length) return undefined;
				at++;
			} else if (c === "\\") {
				delimiter += text[at + 1] ?? "";
				at += 2;
			} else {
				delimiter += c;
				at++;
			}
		}
		return { delimiter, end: at };
	};

	/** Reads a redirection operator at `from` (and a here document's delimiter); returns where the scan resumes, or -1 when it cannot go on. */
	const redirect = (frame: CommandFrame, from: number): number => {
		let at = from;
		if (text[at] === "&") at++;
		const operator = text[at++];
		if (operator === "<" && text[at] === "<" && text[at + 1] !== "<") {
			at++;
			const tabs = text[at] === "-";
			if (tabs) at++;
			while (text[at] === " " || text[at] === "\t") {
				steps++;
				at++;
			}
			const read = readDelimiter(at);
			if (read === undefined) return -1;
			if (read.delimiter !== "") heredocs.push({ delimiter: read.delimiter, tabs });
			return read.end;
		}
		if (operator === "<" && text[at] === "<") at += 2;
		else if (text[at] === ">" || text[at] === "&" || (operator === ">" && text[at] === "|")) at++;
		frame.redirectTarget = true;
		return at;
	};

	/** Skips the bodies of pending here documents, which start at `from`; returns where the scan resumes. */
	const skipHeredocs = (from: number): number => {
		let at = from;
		for (const { delimiter, tabs } of heredocs) {
			while (at < text.length) {
				const newline = text.indexOf("\n", at);
				const end = newline < 0 ? text.length : newline;
				let line = text.slice(at, end);
				steps += line.length + 1;
				if (tabs) line = line.replace(/^\t+/, "");
				at = newline < 0 ? text.length : newline + 1;
				if (line === delimiter) break;
			}
		}
		heredocs.length = 0;
		return at;
	};

	let at = 0;
	scan: while (at < text.length) {
		steps++;
		const frame = stack[stack.length - 1]!;
		const c = text[at]!;
		const next = text[at + 1];
		if (frame.kind === "double") {
			if (c === "\\") {
				if (next === "\n") joins.push(at);
				at += 2;
			}
			else if (c === '"') {
				stack.pop();
				at++;
			} else if (c === "$" && next === "(") {
				stack.push(commandFrame(")"));
				at += 2;
			} else if (c === "$" && next === "{") {
				stack.push({ kind: "brace", quoted: true });
				at += 2;
			} else if (c === "`") {
				stack.push(commandFrame("`"));
				at++;
			} else at++;
			continue;
		}
		if (frame.kind === "arithmetic") {
			if (c === "(") frame.depth++;
			else if (c === ")" && frame.depth > 0) frame.depth--;
			else if (c === ")") {
				stack.pop();
				// $((...)) ends with )); a lone ) ends it too, where bash would have read $( (...) ).
				if (next === ")") at++;
			} else if (c === "$" && next === "(") {
				stack.push(commandFrame(")"));
				at++;
			} else if (c === "$" && next === "{") {
				stack.push({ kind: "brace", quoted: false });
				at++;
			} else if (c === "`") stack.push(commandFrame("`"));
			else if (c === '"') stack.push({ kind: "double" });
			at++;
			continue;
		}
		if (frame.kind === "brace") {
			if (c === "\\") {
				if (next === "\n") joins.push(at);
				at += 2;
			}
			else if (c === "}") {
				stack.pop();
				at++;
			} else if (c === "'" && !frame.quoted) {
				const close = text.indexOf("'", at + 1);
				if (close < 0) break scan;
				steps += close - at;
				at = close + 1;
			} else if (c === '"') {
				stack.push({ kind: "double" });
				at++;
			} else if (c === "$" && next === "(") {
				stack.push(commandFrame(")"));
				at += 2;
			} else if (c === "$" && next === "{") {
				stack.push({ kind: "brace", quoted: frame.quoted });
				at += 2;
			} else if (c === "`") {
				stack.push(commandFrame("`"));
				at++;
			} else at++;
			continue;
		}
		switch (c) {
			case "\\":
				// A backslash-newline joins the lines; any other backslash escapes the next character in a word.
				if (next === "\n") joins.push(at);
				else beginWord(frame, at);
				at += 2;
				break;
			case " ":
			case "\t":
			case "\r":
				endWord(frame, at);
				at++;
				break;
			case "\n":
				endWord(frame, at);
				separate(frame);
				at++;
				if (heredocs.length > 0) at = skipHeredocs(at);
				break;
			case ";":
			case "|":
				endWord(frame, at);
				separate(frame);
				at++;
				break;
			case "&":
				endWord(frame, at, next === ">");
				if (next === ">") {
					at = redirect(frame, at);
					if (at < 0) break scan;
				} else {
					separate(frame);
					at++;
				}
				break;
			case "<":
			case ">":
				endWord(frame, at, true);
				at = redirect(frame, at);
				if (at < 0) break scan;
				break;
			case "#":
				if (frame.wordStart >= 0) at++;
				else {
					const newline = text.indexOf("\n", at);
					steps += (newline < 0 ? text.length : newline) - at;
					at = newline < 0 ? text.length : newline;
				}
				break;
			case "'": {
				beginWord(frame, at);
				const close = text.indexOf("'", at + 1);
				if (close < 0) break scan;
				steps += close - at;
				at = close + 1;
				break;
			}
			case '"':
				beginWord(frame, at);
				stack.push({ kind: "double" });
				at++;
				break;
			case "$":
				beginWord(frame, at);
				if (next === "'") {
					const close = ansiEnd(at + 2);
					if (close < 0) break scan;
					at = close + 1;
				} else if (next === '"') {
					stack.push({ kind: "double" });
					at += 2;
				} else if (next === "(" && text[at + 2] === "(") {
					stack.push({ kind: "arithmetic", depth: 0 });
					at += 3;
				} else if (next === "(") {
					stack.push(commandFrame(")"));
					at += 2;
				} else if (next === "{") {
					stack.push({ kind: "brace", quoted: false });
					at += 2;
				} else at++;
				break;
			case "`":
				if (frame.closer === "`") {
					endWord(frame, at);
					stack.pop();
				} else {
					beginWord(frame, at);
					stack.push(commandFrame("`"));
				}
				at++;
				break;
			case "(":
				beginWord(frame, at);
				stack.push(commandFrame(")"));
				at++;
				break;
			case ")":
				endWord(frame, at);
				if (frame.closer === ")") stack.pop();
				else separate(frame);
				at++;
				break;
			default:
				beginWord(frame, at, true);
				at++;
		}
	}
	// A word that reaches the end of the text ends there, so `X=1 git` at the very end is still read.
	const last = stack[stack.length - 1]!;
	if (at >= text.length && last.kind === "command") endWord(last, text.length);

	if (lifts.length === 0 && joins.length === 0) return { text, flagged: false, steps };
	// A lift starts a word and a join starts at a backslash, so no position holds both.
	const edits = [...lifts.map((at) => ({ at, lift: true })), ...joins.map((at) => ({ at, lift: false }))].sort((a, b) => a.at - b.at);
	let lifted = "";
	let previous = 0;
	for (const edit of edits) {
		lifted += text.slice(previous, edit.at);
		if (edit.lift) {
			lifted += "\n";
			previous = edit.at;
		} else previous = edit.at + 2;
	}
	return { text: lifted + text.slice(previous), flagged: runFlaggedHit, steps };
}
