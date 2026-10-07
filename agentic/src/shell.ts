/**
 * A small POSIX-style shell reader. It splits a command line into simple commands and words,
 * honoring quotes and escapes, and records constructs that defeat static reading instead of
 * guessing at them. It never executes or expands anything.
 */

export type Opaque =
	| "command-substitution"
	| "variable-command"
	| "heredoc"
	| "process-substitution"
	| "unterminated-quote";

export interface SimpleCommand {
	/** Words after leading NAME=value assignments are removed. */
	words: string[];
	/** True when a word came from an unquoted or double-quoted $(...) or `...`. */
	opaque: Opaque[];
	/** Body of a heredoc feeding this command, if any. */
	heredoc?: string;
	/** True when this command reads a pipe from the previous command. */
	fromPipe: boolean;
	/** Targets of output redirections (> and >>), which the command writes. */
	writes: string[];
	/** Leading NAME=value assignments and case subjects; their substitutions still run. */
	assignments: string[];
	/** Subshell nesting: ( ) depth at which this command runs. */
	depth: number;
	/** Operators between the previous command and this one, such as ["&&"] or [")", ";"]. */
	before: string[];
}

export interface ParsedLine {
	commands: SimpleCommand[];
	opaque: Opaque[];
}

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n"];

interface Token {
	kind: "word" | "op" | "heredoc-marker" | "write-target";
	value: string;
	opaque: Opaque[];
}

function tokenize(input: string): { tokens: Token[]; opaque: Opaque[]; heredocBodies: string[] } {
	const tokens: Token[] = [];
	const lineOpaque: Opaque[] = [];
	const heredocBodies: string[] = [];
	const pendingHeredocs: { delimiter: string; strip: boolean }[] = [];
	let i = 0;
	let word = "";
	let wordOpaque: Opaque[] = [];
	let inWord = false;

	// Inside [[ ... ]], && || < > ( ) are part of the conditional expression, not shell syntax.
	let conditionalDepth = 0;
	const flush = () => {
		if (inWord && word === "[[") conditionalDepth++;
		if (inWord && word === "]]" && conditionalDepth > 0) conditionalDepth--;
		if (inWord) tokens.push({ kind: "word", value: word, opaque: wordOpaque });
		word = "";
		wordOpaque = [];
		inWord = false;
	};

	const readSubstitution = (start: number, open: string, close: string): number => {
		let depth = 1;
		let j = start;
		while (j < input.length && depth > 0) {
			if (input[j] === "\\") {
				j += 2;
				continue;
			}
			if (input.startsWith(open, j)) depth++;
			else if (input[j] === close) depth--;
			j++;
		}
		return j;
	};

	while (i < input.length) {
		const c = input[i];
		if (c === "\n" && pendingHeredocs.length > 0) {
			flush();
			tokens.push({ kind: "op", value: "\n", opaque: [] });
			i++;
			for (const pending of pendingHeredocs.splice(0)) {
				const lines: string[] = [];
				while (i <= input.length) {
					const end = input.indexOf("\n", i);
					const line = input.slice(i, end === -1 ? input.length : end);
					i = end === -1 ? input.length + 1 : end + 1;
					const candidate = pending.strip ? line.replace(/^\t+/, "") : line;
					if (candidate === pending.delimiter) break;
					lines.push(line);
					if (end === -1) break;
				}
				heredocBodies.push(lines.join("\n"));
			}
			continue;
		}
		if (c === "#" && !inWord) {
			while (i < input.length && input[i] !== "\n") i++;
			continue;
		}
		if (c === " " || c === "\t") {
			flush();
			i++;
			continue;
		}
		if (c === "\\") {
			inWord = true;
			if (input[i + 1] === "\n") {
				i += 2;
				continue;
			}
			word += input[i + 1] ?? "";
			i += 2;
			continue;
		}
		if (c === "'") {
			inWord = true;
			const end = input.indexOf("'", i + 1);
			if (end === -1) {
				lineOpaque.push("unterminated-quote");
				word += input.slice(i + 1);
				i = input.length;
				continue;
			}
			word += input.slice(i + 1, end);
			i = end + 1;
			continue;
		}
		if (c === '"') {
			inWord = true;
			let j = i + 1;
			let closed = false;
			while (j < input.length) {
				const d = input[j];
				if (d === "\\" && j + 1 < input.length && '$`"\\\n'.includes(input[j + 1])) {
					word += input[j + 1];
					j += 2;
					continue;
				}
				if (d === '"') {
					closed = true;
					j++;
					break;
				}
				if (d === "$" && input[j + 1] === "(") {
					wordOpaque.push("command-substitution");
					const end = readSubstitution(j + 2, "(", ")");
					word += input.slice(j, end);
					j = end;
					continue;
				}
				if (d === "`") {
					wordOpaque.push("command-substitution");
					const end = input.indexOf("`", j + 1);
					word += input.slice(j, end === -1 ? input.length : end + 1);
					j = end === -1 ? input.length : end + 1;
					continue;
				}
				word += d;
				j++;
			}
			if (!closed) lineOpaque.push("unterminated-quote");
			i = j;
			continue;
		}
		if (c === "$" && input[i + 1] === "(") {
			inWord = true;
			wordOpaque.push("command-substitution");
			const end = readSubstitution(i + 2, "(", ")");
			word += input.slice(i, end);
			i = end;
			continue;
		}
		if (c === "`") {
			inWord = true;
			wordOpaque.push("command-substitution");
			const end = input.indexOf("`", i + 1);
			word += input.slice(i, end === -1 ? input.length : end + 1);
			i = end === -1 ? input.length : end + 1;
			continue;
		}
		if (conditionalDepth > 0 && (input.startsWith("&&", i) || input.startsWith("||", i))) {
			flush();
			tokens.push({ kind: "word", value: input.slice(i, i + 2), opaque: [] });
			i += 2;
			continue;
		}
		if (conditionalDepth > 0 && "()<>".includes(c)) {
			inWord = true;
			word += c;
			i++;
			continue;
		}
		if ((c === "<" || c === ">") && input[i + 1] === "(") {
			flush();
			lineOpaque.push("process-substitution");
			const end = readSubstitution(i + 2, "(", ")");
			tokens.push({ kind: "word", value: input.slice(i, end), opaque: ["process-substitution"] });
			i = end;
			continue;
		}
		if (input.startsWith("<<", i) && !input.startsWith("<<<", i)) {
			flush();
			let j = i + 2;
			const strip = input[j] === "-";
			if (strip) j++;
			while (input[j] === " ") j++;
			let delimiter = "";
			const quote = input[j] === "'" || input[j] === '"' ? input[j] : "";
			if (quote) {
				const end = input.indexOf(quote, j + 1);
				delimiter = input.slice(j + 1, end === -1 ? input.length : end);
				j = end === -1 ? input.length : end + 1;
			} else {
				const match = /^[^\s;&|<>]+/.exec(input.slice(j));
				delimiter = match ? match[0] : "";
				j += delimiter.length;
			}
			pendingHeredocs.push({ delimiter, strip });
			tokens.push({ kind: "heredoc-marker", value: delimiter, opaque: [] });
			i = j;
			continue;
		}
		if (c === "(") {
			if (inWord && input[i + 1] === ")") {
				word += "()";
				i += 2;
				continue;
			}
			flush();
			tokens.push({ kind: "op", value: "(", opaque: [] });
			i++;
			continue;
		}
		if (c === ")") {
			flush();
			tokens.push({ kind: "op", value: ")", opaque: [] });
			i++;
			continue;
		}
		const op = OPERATORS.find((candidate) => input.startsWith(candidate, i));
		if (op) {
			flush();
			tokens.push({ kind: "op", value: op, opaque: [] });
			i += op.length;
			continue;
		}
		if ((c === "<" || c === ">") && inWord && /^\d+$/.test(word)) {
			word = "";
			inWord = false;
			wordOpaque = [];
		}
		if (c === "&" && input[i + 1] === ">" && !inWord) {
			i += 1;
			continue;
		}
		if ((c === "<" || c === ">") && !inWord) {
			flush();
			let j = i + 1;
			const duplicates = input[j] === "&";
			if (input[j] === ">" || input[j] === "&" || input[j] === "|") j++;
			while (input[j] === " ") j++;
			let target = "";
			if (input[j] === "'" || input[j] === '"') {
				const end = input.indexOf(input[j], j + 1);
				target = input.slice(j + 1, end === -1 ? input.length : end);
				j = end === -1 ? input.length : end + 1;
			} else {
				const match = /^[^\s;&|<>]+/.exec(input.slice(j));
				target = match ? match[0] : "";
				j += target.length;
			}
			if (c === ">" && !duplicates && target) tokens.push({ kind: "write-target", value: target, opaque: [] });
			i = j;
			continue;
		}
		inWord = true;
		word += c;
		i++;
	}
	flush();
	return { tokens, opaque: lineOpaque, heredocBodies };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseShell(input: string): ParsedLine {
	const { tokens, opaque, heredocBodies } = tokenize(input);
	const commands: SimpleCommand[] = [];
	let depth = 0;
	let ops: string[] = [];
	const fresh = (fromPipe: boolean): SimpleCommand => ({ words: [], opaque: [], fromPipe, writes: [], assignments: [], depth, before: [] });
	let current = fresh(false);
	let heredocIndex = 0;
	const push = (nextFromPipe: boolean) => {
		if (current.words.length > 0 || current.heredoc !== undefined || current.writes.length > 0 || current.assignments.length > 0) {
			commands.push({ ...current, depth: current.depth, before: current.before });
			ops = [];
		}
		current = { ...fresh(nextFromPipe || current.fromPipe && current.words.length === 0), before: ops };
	};
	// case statements: the subject's substitutions run; patterns are not commands; bodies are.
	const caseStack: ("subject" | "pattern" | "body")[] = [];
	for (const token of tokens) {
		const state = caseStack[caseStack.length - 1];
		if (state === "subject") {
			if (token.kind === "word" && token.value === "in") caseStack[caseStack.length - 1] = "pattern";
			else if (token.kind === "word") current.assignments.push(token.value);
			continue;
		}
		if (state === "pattern") {
			if (token.kind === "word" && token.value === "esac") {
				caseStack.pop();
				push(false);
			} else if (token.kind === "op" && token.value === ")") {
				caseStack[caseStack.length - 1] = "body";
			}
			continue;
		}
		if (state === "body" && token.kind === "op" && token.value === ";;") {
			push(false);
			caseStack[caseStack.length - 1] = "pattern";
			continue;
		}
		if (state === "body" && token.kind === "word" && token.value === "esac" && current.words.length === 0) {
			caseStack.pop();
			continue;
		}
		if (token.kind === "word" && token.value === "case" && current.words.length === 0) {
			push(false);
			caseStack.push("subject");
			continue;
		}
		if (token.kind === "op") {
			push(token.value === "|" || token.value === "|&");
			ops.push(token.value);
			if (token.value === "(") depth++;
			if (token.value === ")") depth = Math.max(0, depth - 1);
			current.depth = depth;
			current.before = ops;
			continue;
		}
		if (token.kind === "write-target") {
			current.writes.push(token.value);
			continue;
		}
		if (token.kind === "heredoc-marker") {
			current.heredoc = heredocBodies[heredocIndex++] ?? "";
			current.opaque.push("heredoc");
			continue;
		}
		if (current.words.length === 0 && ASSIGNMENT.test(token.value)) {
			current.assignments.push(token.value);
			continue;
		}
		if (current.words.length === 0 && token.value.startsWith("$")) current.opaque.push("variable-command");
		current.words.push(token.value);
		current.opaque.push(...token.opaque);
	}
	push(false);
	return { commands, opaque };
}
