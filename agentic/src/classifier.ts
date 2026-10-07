import { isAbsolute, join, resolve } from "node:path";
import { parseShell, type SimpleCommand } from "./shell.ts";
import type { ActionId, ClassifiedAction, Resource } from "./types.ts";

/** Read-only facts about the workspace the classifier may ask for. */
export interface ClassifyContext {
	cwd: string;
	repoRoot?: string;
	homeDir: string;
	currentBranch(cwd: string): string | undefined;
	remoteUrl(cwd: string, remote: string): string | undefined;
	defaultBranch(cwd: string, remote: string): string | undefined;
	readFile(path: string): string | undefined;
	/** Shell functions in the script being read that run their arguments ("$@"), with the number of leading arguments each consumes with shift. */
	forwarders?: ReadonlyMap<string, number>;
	/** The agent's environment, for expanding variables the command does not assign itself. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Directories a relative path in this command may resolve against, after cd earlier in the same command line. */
	pathCwds?: string[];
	/** Returns the protected kind of a path (relative to the given cwd), if writing it is a hard point. */
	protectedKind?: (path: string, options?: { cwd?: string; reach?: "path" | "parent" | "ancestor" }) => string | undefined;
}

export interface UnclassifiedPart {
	text: string;
	reason: string;
	couldReachHardPoint: boolean;
	/**
	 * Execution of text that is computed, decoded, or piped in (eval, variable command names,
	 * scripts piped to a shell or interpreter, substitution in hard-point arguments). These go
	 * straight to the user: the O9 eval showed this is where Jev is weakest.
	 */
	opaqueExecution: boolean;
}

export interface CommandClassification {
	actions: ClassifiedAction[];
	unclassified: UnclassifiedPart[];
}

const MAX_DEPTH = 4;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETERS = new Set(["python", "python3", "node", "bun", "deno", "ruby", "perl", "php", "osascript"]);
const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "nice", "nohup", "time", "caffeinate"]);
const LOW_RISK_RUNNERS: [string, string[]][] = [
	["bun", ["test", "install", "add", "remove", "update", "outdated", "x", "pm", "build", "init", "create", "link", "unlink", "upgrade", "repl"]],
	["npm", ["test", "install", "ci", "ls"]],
	["pnpm", ["test", "install"]],
	["yarn", ["test", "install"]],
	["cargo", ["test", "build", "check", "clippy", "fmt", "run"]],
	["go", ["test", "build", "vet", "run"]],
	["make", []],
	["just", []],
	["pytest", []],
	["tsc", []],
];
const NETWORKY = /\b(git\s+push|gh\s+(pr|issue|api|release|secret|repo)|api\.github\.com|curl\b|wget\b|requests\.(post|put|patch|delete)|fetch\(|http\.request|urllib|urlopen|subprocess|child_process|spawn|execSync|exec\(|Bun\.spawn|Bun\.\$|socket|ssh\b|scp\b|rsync\b)/;

function result(actions: ClassifiedAction[] = [], unclassified: UnclassifiedPart[] = []): CommandClassification {
	return { actions, unclassified };
}

function merge(into: CommandClassification, from: CommandClassification): void {
	into.actions.push(...from.actions);
	into.unclassified.push(...from.unclassified);
}

function opaque(text: string, reason: string, couldReachHardPoint = true): CommandClassification {
	return result([], [{ text, reason, couldReachHardPoint, opaqueExecution: false }]);
}

function opaqueExecution(text: string, reason: string): CommandClassification {
	return result([], [{ text, reason, couldReachHardPoint: true, opaqueExecution: true }]);
}

/** Normalizes a git remote URL or path into a stable repository identity. */
export function repoIdentity(urlOrPath: string): string {
	const trimmed = urlOrPath.trim().replace(/\.git$/, "").replace(/\/$/, "");
	const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(trimmed);
	if (scp) return `${scp[1]}/${scp[2]}`;
	try {
		const url = new URL(trimmed);
		if (url.protocol === "file:") return url.pathname;
		return `${url.host}${url.pathname}`.replace(/\/$/, "");
	} catch {
		return trimmed;
	}
}

function stripWrappers(words: string[]): string[] {
	let rest = [...words];
	for (;;) {
		const head = rest[0];
		if (head === undefined) return rest;
		if (head === "env") {
			rest = rest.slice(1);
			while (rest[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || rest[0].startsWith("-"))) rest = rest.slice(1);
			continue;
		}
		if (head === "timeout") {
			rest = rest.slice(1);
			while (rest[0]?.startsWith("-")) rest = rest.slice(1);
			rest = rest.slice(1);
			continue;
		}
		if (head === "command" && (rest[1] === "-v" || rest[1] === "-V")) return [];
		if (WRAPPERS.has(head)) {
			rest = rest.slice(1);
			while (rest[0]?.startsWith("-")) rest = rest.slice(1);
			continue;
		}
		return rest;
	}
}

/**
 * Expands $NAME and ${NAME} from the agent's environment when the command text does not assign
 * NAME itself (an assignment in the same command could change the value the shell will use).
 * Positional and special parameters ($@, $1, $?) are never expanded.
 */
function expandVariables(word: string, ctx: ClassifyContext, line: string): string {
	if (!ctx.env || !word.includes("$")) return word;
	return word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced: string | undefined, bare: string | undefined) => {
		const name = (braced ?? bare) as string;
		const value = ctx.env?.[name];
		if (value === undefined) return match;
		if (new RegExp(`(^|[\\s;&|(])(export\\s+|local\\s+|readonly\\s+|declare\\s+(-\\w+\\s+)?)?${name}=`).test(line)) return match;
		return value;
	});
}

/** Conditionals run nothing but their substitutions, which are classified separately. */
const CONDITIONALS = new Set(["[[", "[", "test", "(("]);

const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "}", ")", "time", "coproc"]);

/** Removes leading shell keywords, grouping tokens, and function headers so the real command shows. */
function stripKeywords(words: string[]): string[] {
	let rest = words;
	for (;;) {
		const head = rest[0];
		if (head === undefined) return rest;
		if (KEYWORDS.has(head)) rest = rest.slice(1);
		else if (head === "function" && rest[1]) rest = rest.slice(2);
		else if (/^[A-Za-z_][\w-]*\(\)$/.test(head)) rest = rest.slice(1);
		else if (head.startsWith("(") && head.length > 1) rest = [head.slice(1), ...rest.slice(1)];
		else return rest;
	}
}

function basename(word: string): string {
	return word.split("/").pop() ?? word;
}

/** Extracts the inner text of every $(...) and `...` in a word, for recursive reading. */
function substitutions(word: string): string[] {
	const found: string[] = [];
	const re = /\$\(((?:[^()]|\([^()]*\))*)\)|`([^`]*)`/g;
	for (const match of word.matchAll(re)) found.push(match[1] ?? match[2] ?? "");
	return found;
}

function resolvePath(ctx: ClassifyContext, path: string): string {
	if (path === "~") return ctx.homeDir;
	if (path.startsWith("~/")) return join(ctx.homeDir, path.slice(2));
	return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

export function classifyCommand(command: string, ctx: ClassifyContext, depth = 0): CommandClassification {
	if (depth > MAX_DEPTH) return opaque(command, "nested too deeply to read");
	const parsed = parseShell(command);
	const out = result();
	if (parsed.opaque.includes("unterminated-quote")) out.unclassified.push({ text: command, reason: "unterminated quote", couldReachHardPoint: NETWORKY.test(command), opaqueExecution: false });
	const dirs = new DirectoryTracker(ctx);
	for (const simple of parsed.commands) merge(out, classifySimple(simple, command, { ...ctx, pathCwds: dirs.before(simple) }, depth));
	return out;
}

/**
 * Where relative paths may resolve as the shell runs a command line: cd and pushd move the
 * directory, so a protected path cannot hide behind a relative name. After "cd X &&" only X
 * applies, because the rest runs only if cd succeeded; after ";", "||", "&", or a pipe, a failed
 * cd leaves the old directory, so both apply. A subshell restores the directory when it ends.
 * A target that cannot be read statically (cd -, popd, $VAR) keeps every directory seen so far.
 * Only path resolution follows cd; git context stays at the call's directory.
 */
class DirectoryTracker {
	private dirs: string[];
	private readonly seen: Set<string>;
	private readonly stack: string[][] = [];
	private depth = 0;
	private pending: { prior: string[]; target: string[] } | undefined;

	constructor(private readonly ctx: ClassifyContext) {
		this.dirs = [ctx.cwd];
		this.seen = new Set([ctx.cwd]);
	}

	/** The directories for this command; afterwards records any cd it performs. */
	before(simple: SimpleCommand): string[] {
		while (this.depth < simple.depth) {
			this.stack.push(this.dirs);
			this.depth++;
		}
		while (this.depth > simple.depth) {
			this.dirs = this.stack.pop() ?? [this.ctx.cwd];
			this.depth--;
			this.pending = undefined;
		}
		if (this.pending) {
			const certain = simple.before.length > 0 && simple.before.every((op) => op === "&&");
			this.dirs = certain ? this.pending.target : [...new Set([...this.pending.prior, ...this.pending.target])];
			if (!certain) this.pending = undefined;
		}
		const current = this.dirs;
		this.record(simple, current);
		return current;
	}

	private record(simple: SimpleCommand, current: string[]): void {
		const [name, ...args] = simple.words;
		if (!["cd", "pushd", "popd"].includes(name ?? "")) return;
		const target = args.find((arg) => !arg.startsWith("-") || arg === "-");
		let next: string[];
		if (name === "popd" || target === "-" || target?.includes("$")) next = [...this.seen];
		else if (target === undefined) next = name === "pushd" ? [...this.seen] : [this.ctx.homeDir];
		else next = current.map((dir) => resolvePath({ ...this.ctx, cwd: dir }, target));
		for (const dir of next) this.seen.add(dir);
		this.pending = { prior: this.pending ? [...new Set([...this.pending.prior, ...current])] : current, target: next };
	}
}

/** Commands that move or delete their operands, so a directory above a protected path counts. */
const REMOVES = new Set(["rm", "rmdir", "unlink", "mv", "shred", "trash"]);
/** Commands whose destination (last operand) may be a directory they copy into. */
const COPIES_INTO = new Set(["cp", "rsync", "install", "ln", "ditto", "scp"]);
/** Interpreters whose first operand is the script they run, which is execution, not a write. */
const RUNS_SCRIPT = new Set(["bun", "node", "deno", "python", "python3", "sh", "bash", "zsh", "perl", "ruby"]);

function classifySimple(simple: SimpleCommand, line: string, ctx: ClassifyContext, depth: number): CommandClassification {
	const text = simple.words.join(" ");
	const out = result();
	for (const word of [...simple.assignments, ...simple.words]) for (const inner of substitutions(word)) merge(out, classifyCommand(inner, ctx, depth + 1));
	let words = stripWrappers(stripKeywords(simple.words.map((word) => expandVariables(word, ctx, line))));
	while (words.length > 0 && ctx.forwarders?.has(words[0])) words = stripWrappers(stripKeywords(words.slice(1 + (ctx.forwarders.get(words[0]) ?? 0))));
	if (words.length === 0) {
		merge(out, protectedWrites(simple, [], "", ctx, text));
		return out;
	}
	if (CONDITIONALS.has(words[0])) {
		merge(out, protectedWrites(simple, [], "", ctx, text));
		return out;
	}
	if (words[0].startsWith("$")) {
		if (FORWARD_TOKEN.test(words[0]) && ctx.forwarders && ctx.forwarders.size > 0) return out;
		merge(out, opaqueExecution(text, "command name comes from a variable"));
		return out;
	}
	const name = basename(words[0]);
	const args = words.slice(1);
	const hasSubstitution = simple.opaque.includes("command-substitution");
	merge(out, protectedWrites(simple, words, name, ctx, text));

	if (SHELLS.has(name)) {
		merge(out, classifyShellInvocation(args, simple, ctx, depth));
		return out;
	}
	if (INTERPRETERS.has(name)) {
		merge(out, classifyInterpreter(name, args, simple, ctx, depth));
		return out;
	}
	if (name === "eval" || name === "source" || name === ".") {
		if (name === "eval") merge(out, opaqueExecution(text, "eval runs text that cannot be read statically"));
		else merge(out, classifyScriptFile(args[0], ctx, depth, text));
		return out;
	}
	if (words[0].includes("/") && !KNOWN_BY_NAME.has(name)) {
		merge(out, classifyExecutablePath(words[0], args, ctx, depth, text));
		return out;
	}
	if (name === "xargs") {
		const sub = args.filter((arg) => !arg.startsWith("-"));
		if (sub.length > 0 && NETWORKY.test(sub.join(" "))) merge(out, opaque(text, "xargs builds commands from input that cannot be read"));
		return out;
	}
	if (name === "ssh") {
		const positional = args.filter((arg) => !arg.startsWith("-"));
		merge(out, opaque(text, positional.length > 1 ? "runs a command on a remote host" : "opens a remote shell"));
		return out;
	}
	if (simple.heredoc !== undefined && (name === "git" || name === "gh" || name === "curl")) {
		merge(out, opaque(text, "reads a heredoc into a network command"));
		return out;
	}

	let recognized: CommandClassification | undefined;
	switch (name) {
		case "git":
			recognized = classifyGit(args, ctx, text);
			break;
		case "gh":
			recognized = classifyGh(args, ctx, text);
			break;
		case "curl":
		case "wget":
		case "http":
		case "https":
			recognized = classifyHttpClient(name, args, ctx, text);
			break;
		default:
			recognized = classifyOther(name, args, ctx, text, depth);
	}
	if (hasSubstitution && (recognized.actions.length > 0 || recognized.unclassified.length > 0)) {
		merge(out, opaqueExecution(text, "arguments come from command substitution"));
		return out;
	}
	merge(out, recognized);
	return out;
}

const READ_ONLY = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "rg", "ls", "wc", "diff", "jq", "bat", "stat", "file", "test", "[", "realpath", "readlink", "du", "sha256sum", "shasum", "md5", "md5sum", "column", "sort", "uniq", "cut", "echo", "printf", "basename", "dirname", "tree", "eza", "cd", "pushd", "popd"]);
/** Git subcommands that rewrite the working tree or move HEAD under it. */
const GIT_REWRITES_TREE = new Set(["checkout", "switch", "reset", "restore", "stash", "clean", "rebase", "merge", "pull", "am", "apply", "cherry-pick", "revert", "rm", "mv", "worktree", "bisect", "sparse-checkout", "read-tree", "checkout-index", "update-index", "filter-branch", "filter-repo"]);

/** The subcommand of a git invocation, skipping global options and their values. */
function gitSubcommand(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i])) i++;		else if (!args[i].startsWith("-")) return args[i];
	}
	return undefined;
}

const GIT_READ_ONLY = new Set(["log", "show", "status", "diff", "rev-parse", "for-each-ref", "ls-remote", "cat-file", "ls-files", "ls-tree", "blame", "describe", "shortlog", "rev-list", "merge-base", "grep"]);

function isReadOnly(name: string, args: string[]): boolean {
	if (READ_ONLY.has(name)) return true;
	if (name === "find") return !args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(arg));
	if (name === "git") return GIT_READ_ONLY.has(args.find((arg) => !arg.startsWith("-") && !arg.includes("/") && !arg.includes("=")) ?? "");
	return false;
}

/**
 * Writes into protected configuration paths: output redirections into them, and any
 * non-read-only command that names one. Also the learning tool's approve subcommand, which
 * only the user may run. Reads of protected paths stay outside policy.
 */
function protectedWrites(simple: SimpleCommand, words: string[], name: string, ctx: ClassifyContext, text: string): CommandClassification {
	const out = result();
	if (!ctx.protectedKind) return out;
	const seen = new Set<string>();
	const add = (path: string, kind: string) => {
		if (seen.has(path)) return;
		seen.add(path);
		out.actions.push({ action: "file.write", resource: { kind: "ProtectedPath", protectedKind: kind, path }, force: false, evidence: text });
	};
	const cwds = ctx.pathCwds ?? [ctx.cwd];
	const check = (candidate: string, reach: "path" | "parent" | "ancestor" | "checkout" = "path", only?: (kind: string) => boolean) => {
		const here = candidate.replace(/^(?:\$PWD|\$\{PWD\}|\$\(pwd\)|`pwd`)(?=\/|$)/, "");
		for (const cwd of cwds) {
			const path = here === candidate ? candidate : `${cwd}${here}`;
			const kind = ctx.protectedKind?.(path, { cwd, reach });
			if (kind && (only === undefined || only(kind))) return add(candidate, kind);
		}
	};
	for (const target of simple.writes) check(target);
	// A bare assignment (X=dir; export X) can set where a later command writes, such as an orch
	// store. Naming the gate's own files in a variable is not a write, so enforcement paths are
	// skipped here (observed: A=<path to the agentic CLI>; $A ... was stopped).
	if (words.length === 0) for (const assignment of simple.assignments) check(expandVariables(assignment.slice(assignment.indexOf("=") + 1), ctx, text), "path", (kind) => kind !== "enforcement");
	if (words.length > 0 && !isReadOnly(name, words.slice(1))) {
		const operands = words.slice(1).filter((word) => !word.startsWith("-"));
		const destination = operands.at(-1);
		const script = RUNS_SCRIPT.has(name) ? operands[0] : undefined;
		// Assignments (prefix, or through env) such as ORCH_STORE=dir configure where the command writes.
		const assigned = [...simple.assignments, ...simple.words.filter((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))];
		const values = assigned.map((assignment) => expandVariables(assignment.slice(assignment.indexOf("=") + 1), ctx, text));
		for (const word of [...words.slice(1), ...values]) {
			if (word === script) continue;
			const reach = REMOVES.has(name) ? "ancestor" : COPIES_INTO.has(name) && word === destination ? "parent" : "path";
			for (const candidate of word.includes("=") ? [word, word.slice(word.indexOf("=") + 1)] : [word]) check(candidate, reach);
		}
		// A copy lands at destination/basename(source), or in the destination itself for a source
		// ending in "/"; landing on a directory above a protected path can replace it.
		// ditto always merges the source's contents into the destination.
		if (COPIES_INTO.has(name) && destination !== undefined) {
			for (const source of operands.slice(0, -1)) check(source.endsWith("/") || name === "ditto" ? destination : `${destination.replace(/\/$/, "")}/${basename(source)}`, "ancestor");
		}
		// Commands that rewrite a checkout's working tree, in the checkout the gate runs from: the
		// tree comes from -C, --work-tree, or GIT_WORK_TREE.
		if (name === "git" && GIT_REWRITES_TREE.has(gitSubcommand(words.slice(1)) ?? "")) {
			const chdirs = words.flatMap((word, index) => (words[index - 1] === "-C" ? [word] : []));
			const base = chdirs.length > 0 ? chdirs.reduce((dir, next) => (isAbsolute(next) ? next : `${dir}/${next}`)) : ".";
			const trees = [
				...words.flatMap((word, index) => (words[index - 1] === "--work-tree" ? [word] : word.startsWith("--work-tree=") ? [word.slice("--work-tree=".length)] : [])),
				...assigned.filter((assignment) => assignment.startsWith("GIT_WORK_TREE=")).map((assignment) => assignment.slice("GIT_WORK_TREE=".length)),
			];
			for (const tree of trees.length > 0 ? trees : [base]) check(isAbsolute(tree) || tree.startsWith("~") || tree === base ? tree : `${base}/${tree}`, "checkout");
		}
	}
	if (words.some((word) => word.endsWith("learning/cli.ts")) && words.includes("approve")) add("learning approve", "learned");
	return out;
}

function classifyShellInvocation(args: string[], simple: SimpleCommand, ctx: ClassifyContext, depth: number): CommandClassification {
	const text = simple.words.join(" ");
	const cIndex = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
	if (cIndex !== -1) {
		const script = args[cIndex + 1];
		if (script === undefined) return opaque(text, "shell -c without a script");
		return classifyCommand(script, ctx, depth + 1);
	}
	if (args.some((arg) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg) && !arg.includes("c"))) return result();
	if (simple.heredoc !== undefined) return classifyScriptText(simple.heredoc, [], ctx, depth);
	const fileIndex = args.findIndex((arg) => !arg.startsWith("-"));
	if (fileIndex !== -1) return classifyScriptFile(args[fileIndex], ctx, depth, text, args.slice(fileIndex + 1));
	if (simple.fromPipe) return opaqueExecution(text, "a shell reads a script from a pipe");
	return opaque(text, "an interactive shell", false);
}

const FORWARD_TOKEN = /^\$(?:@|\{@\}|\*|\{\*\})$/;
const FORWARD_LINE = /^\s*(?:exec\s+|command\s+)?"?\$(?:@|\{@\}|\*)"?\s*;?\s*$/;
const FUNCTION_DEF = /(?:^|[\n;&|])\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{([\s\S]*?)(?:;\s*\}|\n\s*\})/g;
// "$@" counts only in command position: at a statement start, after ; { & | or then/do.
const RUNS_ARGS = /(?:^|[;{&|]|\bthen|\bdo)\s*(?:exec\s+|command\s+)?"?\$(?:@|\{@\})"?(?=\s*(?:;|$|[<>|&]))/m;

/**
 * Reads a script with its argument forwarding resolved. A function whose body runs "$@" is a
 * forwarder: its call sites are classified as the commands they forward, and the "$@" inside
 * its body is not opaque. A top-level "$@" line runs the script's own arguments, which are
 * visible on the invoking command line. Any other variable execution stays opaque.
 */
export function classifyScriptText(content: string, scriptArgs: string[], ctx: ClassifyContext, depth: number): CommandClassification {
	const forwarders = new Map<string, number>();
	const bodies: [number, number][] = [];
	for (const match of content.matchAll(FUNCTION_DEF)) {
		const runs = RUNS_ARGS.exec(match[2]);
		if (runs) {
			const before = match[2].slice(0, runs.index);
			const shifts = [...before.matchAll(/(?:^|[\s;{])shift(?:\s+(\d+))?(?=\s*(?:;|$))/gm)].reduce((sum, m) => sum + Number(m[1] ?? 1), 0);
			forwarders.set(match[1], shifts);
			bodies.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
		}
	}
	let offset = 0;
	const kept = content.split("\n").map((line) => {
		const at = offset;
		offset += line.length + 1;
		if (!FORWARD_LINE.test(line) || bodies.some(([from, to]) => at >= from && at < to)) return line;
		return scriptArgs.length > 0 ? scriptArgs.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ") : line;
	});
	return classifyCommand(kept.join("\n"), { ...ctx, forwarders }, depth + 1);
}

const KNOWN_BY_NAME = new Set(["agentic", "git", "gh", "curl", "wget", "http", "https", "npm", "pnpm", "yarn", "cargo", "docker", "podman", "kubectl", "terraform", "helm", "pulumi", "fly", "flyctl", "vercel", "serverless", "security", "aws", "rm", "ssh", "eval", ...SHELLS, ...INTERPRETERS]);
const SHELL_SHEBANG = /^#!\S*(?:\/|\s|env\s+)(?:ba|z|da|k)?sh\b/;

/**
 * Runs of an executable by path are read by what the file actually is: shell scripts (by
 * shebang or .sh) are classified recursively with their arguments; scripts for other
 * interpreters are checked for network or git use; compiled binaries are outside policy unless
 * their name is a recognized tool (handled before this point).
 */
/** Reads a script the shell would run, from any directory a cd in the same command may have moved to. */
function readScript(ctx: ClassifyContext, path: string): string | undefined {
	return (ctx.pathCwds ?? [ctx.cwd]).map((cwd) => ctx.readFile(resolvePath({ ...ctx, cwd }, path))).find((text) => text !== undefined);
}

function classifyExecutablePath(path: string, args: string[], ctx: ClassifyContext, depth: number, text: string): CommandClassification {
	const content = readScript(ctx, path);
	if (content === undefined) return opaque(text, `cannot read ${path}`);
	if (content.includes("\u0000")) return result();
	const firstLine = content.split("\n", 1)[0];
	if (SHELL_SHEBANG.test(firstLine) || (!firstLine.startsWith("#!") && path.endsWith(".sh"))) return classifyScriptText(content, args, ctx, depth);
	const out = protectedReferences(content, ctx, text);
	if (NETWORKY.test(content)) merge(out, opaque(text, `${path} may reach the network or run git`));
	return out;
}

function classifyScriptFile(path: string | undefined, ctx: ClassifyContext, depth: number, text: string, scriptArgs: string[] = []): CommandClassification {
	if (!path) return opaque(text, "script path missing");
	// Observed: cd <repo> && <script> could not be read when resolved from the call's directory.
	const content = readScript(ctx, path);
	if (content === undefined) return opaque(text, `cannot read script ${path}`);
	return classifyScriptText(content, scriptArgs, ctx, depth);
}

function classifyInterpreter(name: string, args: string[], simple: SimpleCommand, ctx: ClassifyContext, depth: number): CommandClassification {
	const text = simple.words.join(" ");
	if (name === "bun") {
		const sub = args[0];
		// bun <path>/agentic ... is the agentic CLI, whose verify record is a policy action.
		if (sub !== undefined && basename(sub) === "agentic") return classifyOther("agentic", args.slice(1), ctx, text, depth);
		const low = LOW_RISK_RUNNERS.find(([runner]) => runner === "bun")?.[1] ?? [];
		if (sub && low.includes(sub)) return result();
		if (sub === "run" && args[1] && !args[1].includes(".")) return classifyPackageScript(args[1], ctx, depth, text);
	}
	const evalIndex = args.findIndex((arg) => arg === "-c" || arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print");
	let code: string | undefined;
	if (evalIndex !== -1) code = args[evalIndex + 1];
	else if (simple.heredoc !== undefined) code = simple.heredoc;
	else {
		const file = args.find((arg) => !arg.startsWith("-") && arg !== "run");
		if (file) {
			code = ctx.readFile(resolvePath(ctx, file));
			if (code === undefined) return opaque(text, `cannot read ${file}`);
		} else if (simple.fromPipe) return opaqueExecution(text, `${name} reads code from a pipe`);
		else return result();
	}
	if (code === undefined) return opaque(text, `${name} code missing`);
	const out = protectedReferences(code, ctx, text);
	if (NETWORKY.test(code)) merge(out, opaque(text, `${name} code may reach the network or run git`));
	return out;
}

/**
 * Code for another interpreter that names a protected path is treated as writing it: static
 * reading cannot tell a read from a write in arbitrary code. Paths assembled at run time are
 * not visible here; the forge and a separate agent identity cover that (design L5, O4).
 */
function protectedReferences(code: string, ctx: ClassifyContext, text: string): CommandClassification {
	const out = result();
	if (!ctx.protectedKind) return out;
	const seen = new Set<string>();
	const candidates = [...code.matchAll(/(["'`])((?:(?!\1)[^\n\\]|\\.)+)\1/g)].map((m) => m[2]).concat([...code.matchAll(/(?:^|[\s(=,])((?:\.{1,2}|~)?\/[^\s"'`;,)]+|[\w.-]+\/[\w./-]+)/g)].map((m) => m[1]));
	for (const candidate of candidates) {
		const kind = (ctx.pathCwds ?? [ctx.cwd]).map((cwd) => ctx.protectedKind?.(candidate, { cwd })).find(Boolean);
		if (kind && !seen.has(candidate)) {
			seen.add(candidate);
			out.actions.push({ action: "file.write", resource: { kind: "ProtectedPath", protectedKind: kind, path: candidate }, force: false, evidence: text });
		}
	}
	return out;
}

function classifyPackageScript(script: string, ctx: ClassifyContext, depth: number, text: string): CommandClassification {
	const pkg = ctx.readFile(join(ctx.repoRoot ?? ctx.cwd, "package.json"));
	if (!pkg) return opaque(text, "package.json not readable");
	try {
		const body = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts?.[script];
		if (body === undefined) return opaque(text, `package script ${script} not found`);
		return classifyCommand(body, ctx, depth + 1);
	} catch {
		return opaque(text, "package.json not parseable");
	}
}

function classifyOther(name: string, args: string[], ctx: ClassifyContext, text: string, depth: number): CommandClassification {
	if (["npm", "pnpm", "yarn"].includes(name)) {
		const sub = args[0];
		if (sub === "publish") return actionResult("release.publish", { kind: "Target", targetKind: "package", label: `${name} publish` }, text);
		if (sub === "run" && args[1]) return classifyPackageScript(args[1], ctx, depth, text);
		return result();
	}
	if (name === "agentic" && args[0] === "verify" && args[1] === "record") {
		// Read the PR exactly as the verify CLI does (Number of the argument after "record"); when
		// it is not a positive integer the author check cannot run, so the call is not read as safe.
		const pr = Number(args[2]);
		if (!Number.isInteger(pr) || pr <= 0) return opaqueExecution(text, "agentic verify record without a pull request number the gate can read");
		return actionResult("verdict.record", { kind: "PullRequest", number: pr, headSha: "", repo: ghRepo(args, ctx) }, text);
	}
	if (name === "cargo" && args[0] === "publish") return actionResult("release.publish", { kind: "Target", targetKind: "crate", label: "cargo publish" }, text);
	if ((name === "twine" && args[0] === "upload") || (name === "gem" && args[0] === "push")) return actionResult("release.publish", { kind: "Target", targetKind: "package", label: text }, text);
	if ((name === "docker" || name === "podman") && args[0] === "push") return actionResult("release.publish", { kind: "Target", targetKind: "image", label: args[1] ?? "image" }, text);
	const deploy =
		(name === "kubectl" && ["apply", "delete", "rollout", "scale", "replace", "patch", "create"].includes(args[0] ?? "")) ||
		(name === "terraform" && ["apply", "destroy"].includes(args[0] ?? "")) ||
		(name === "helm" && ["install", "upgrade", "uninstall", "rollback"].includes(args[0] ?? "")) ||
		(name === "pulumi" && ["up", "destroy"].includes(args[0] ?? "")) ||
		(name === "fly" && args[0] === "deploy") ||
		(name === "flyctl" && args[0] === "deploy") ||
		(name === "vercel" && (args.includes("--prod") || args[0] === "deploy")) ||
		(name === "serverless" && args[0] === "deploy");
	if (deploy) return actionResult("deploy", { kind: "Target", targetKind: name, label: text }, text);
	if (name === "security" && /^(add|delete|set)-/.test(args[0] ?? "")) return actionResult("credential.change", { kind: "Target", targetKind: "keychain", label: args[0] ?? "" }, text);
	if (name === "aws" && args[0] === "iam") return actionResult("credential.change", { kind: "Target", targetKind: "aws-iam", label: text }, text);
	if (name === "dropdb" || (name === "redis-cli" && args.some((arg) => /^flush(all|db)$/i.test(arg)))) return actionResult("data.delete", { kind: "Target", targetKind: "database", label: text }, text);
	if (name === "rm" && args.some((arg) => /^-[a-zA-Z]*[rRf]/.test(arg))) {
		const dirs = ctx.pathCwds ?? [ctx.cwd];
		const targets = args.filter((arg) => !arg.startsWith("-")).flatMap((arg) => dirs.map((cwd) => resolvePath({ ...ctx, cwd }, arg)));
		const root = ctx.repoRoot ?? ctx.cwd;
		// Temporary directories are scratch, not data (observed: a child agent's own $TMPDIR build context was stopped as data deletion).
		const scratch = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", ...(ctx.env?.TMPDIR ? [`${ctx.env.TMPDIR.replace(/\/+$/, "")}/`] : [])];
		const outside = targets.filter((target) => !(target === root || target.startsWith(`${root}/`)) && !scratch.some((prefix) => target.startsWith(prefix)));
		if (outside.length > 0) return actionResult("data.delete", { kind: "Target", targetKind: "path", label: outside.join(" ") }, text);
	}
	return result();
}

function actionResult(action: ActionId, resource: Resource, evidence: string, force = false): CommandClassification {
	return result([{ action, resource, force, evidence }]);
}

const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function classifyGit(args: string[], ctx: ClassifyContext, text: string): CommandClassification {
	let cwd = ctx.cwd;
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const option = args[i];
		if (option === "-C") cwd = resolve(cwd, args[i + 1] ?? ".");
		if (GIT_OPTIONS_WITH_VALUE.has(option)) i += 2;
		else i += 1;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	if (sub !== "push") return result();
	return classifyGitPush(rest, { ...ctx, cwd }, text);
}

const PUSH_OPTIONS_WITH_VALUE = new Set(["--repo", "--receive-pack", "--exec", "-o", "--push-option", "--recurse-submodules"]);

function classifyGitPush(args: string[], ctx: ClassifyContext, text: string): CommandClassification {
	let force = false;
	let del = false;
	let dryRun = false;
	let all = false;
	let tags = false;
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
			i++;
			continue;
		}
		if (arg === "--") continue;
		if (arg.startsWith("--")) {
			if (arg === "--force" || arg.startsWith("--force-with-lease") || arg === "--force-if-includes") force = true;
			else if (arg === "--delete") del = true;
			else if (arg === "--dry-run") dryRun = true;
			else if (arg === "--all" || arg === "--mirror" || arg === "--branches") all = true;
			else if (arg === "--tags" || arg === "--follow-tags") tags = true;
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) {
			if (arg.includes("f")) force = true;
			if (arg.includes("d")) del = true;
			if (arg.includes("n")) dryRun = true;
			continue;
		}
		positional.push(arg);
	}
	if (dryRun) return result();
	const remote = positional[0] ?? "origin";
	const refspecs = positional.slice(1);
	const repo = repoIdentity(ctx.remoteUrl(ctx.cwd, remote) ?? remote);
	const defaultBranch = ctx.defaultBranch(ctx.cwd, remote);
	const isDefault = (branch: string) => (defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master");
	if (all) return opaque(text, "pushes every branch or mirrors the repository");
	const out = result();
	if (tags && refspecs.length === 0) out.actions.push({ action: "release.publish", resource: { kind: "Target", targetKind: "tags", label: `${repo} tags` }, force, evidence: text });
	const specs = refspecs.length > 0 ? refspecs : tags ? [] : ["HEAD"];
	for (const raw of specs) {
		let spec = raw;
		let specForce = force;
		if (spec.startsWith("+")) {
			specForce = true;
			spec = spec.slice(1);
		}
		let src = spec;
		let dst = spec;
		const colon = spec.indexOf(":");
		if (colon !== -1) {
			src = spec.slice(0, colon);
			dst = spec.slice(colon + 1);
		}
		const deleting = del || (colon !== -1 && src === "");
		if (dst === "HEAD" || dst === "") {
			const current = ctx.currentBranch(ctx.cwd);
			if (!current) return opaque(text, "cannot resolve the current branch");
			dst = current;
		}
		if (dst.startsWith("refs/tags/") || (src.startsWith("refs/tags/") && colon === -1)) {
			out.actions.push({ action: "release.publish", resource: { kind: "Target", targetKind: "tag", label: dst.replace("refs/tags/", "") }, force: specForce, evidence: text });
			continue;
		}
		const branch = dst.replace(/^refs\/heads\//, "");
		out.actions.push({
			action: deleting ? "git.delete_remote_branch" : "git.push",
			resource: { kind: "Branch", name: branch, isDefault: isDefault(branch), repo },
			force: specForce,
			evidence: text,
		});
	}
	return out;
}

/**
 * The repository a gh command targets. -R/--repo takes OWNER/REPO, HOST/OWNER/REPO, or a URL;
 * a bare word there is treated as a git remote name (agents pass "origin"), resolved like the
 * default origin.
 */
function ghRepo(args: string[], ctx: ClassifyContext): string {
	const index = args.findIndex((arg) => arg === "-R" || arg === "--repo");
	const inline = args.find((arg) => arg.startsWith("--repo="))?.slice(7);
	const value = inline ?? (index !== -1 ? args[index + 1] : undefined);
	if (value && /^[\w.-]+\/[\w.-]+$/.test(value)) return repoIdentity(`github.com/${value}`);
	if (value && (value.includes("://") || /^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(value) || value.includes("@"))) return repoIdentity(value);
	const remote = value ?? "origin";
	return repoIdentity(ctx.remoteUrl(ctx.cwd, remote) ?? remote);
}

function firstPositional(args: string[]): string | undefined {
	const withValue = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--title", "-B", "--base", "-H", "--head", "-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template"]);
	for (let i = 0; i < args.length; i++) {
		if (withValue.has(args[i])) {
			i++;
			continue;
		}
		if (!args[i].startsWith("-")) return args[i];
	}
	return undefined;
}

function prNumber(ref: string | undefined): number {
	if (!ref) return 0;
	const match = /(\d+)(?:\/?$|#)/.exec(ref) ?? /^(\d+)$/.exec(ref);
	return match ? Number(match[1]) : 0;
}

function classifyGh(args: string[], ctx: ClassifyContext, text: string): CommandClassification {
	const group = args[0];
	const verb = args[1];
	const rest = args.slice(2);
	const repo = ghRepo(args, ctx);
	const hasBody = rest.some((arg) => ["-b", "--body", "-F", "--body-file", "-c", "--comment", "--approve", "-a", "-r", "--request-changes"].includes(arg));
	const recipient = (label: string): Resource => ({ kind: "Recipient", recipientKind: "unknown", label: `${repo}:${label}` });
	if (group === "pr") {
		const ref = firstPositional(rest);
		if (verb === "create") return actionResult("pr.create", { kind: "Repo", origin: repo }, text);
		if (verb === "merge") return actionResult("pr.merge", { kind: "PullRequest", number: prNumber(ref), headSha: "", repo }, text);
		if (verb === "comment" || verb === "review" || (["close", "reopen", "edit", "ready"].includes(verb ?? "") && hasBody)) return actionResult("comment.post", recipient(`pr#${prNumber(ref)}`), text);
		return result();
	}
	if (group === "issue") {
		const ref = firstPositional(rest);
		if (verb === "comment" || verb === "create" || (["close", "reopen", "edit"].includes(verb ?? "") && hasBody)) return actionResult("comment.post", recipient(`issue#${prNumber(ref)}`), text);
		return result();
	}
	if (group === "release" && ["create", "upload", "edit", "delete"].includes(verb ?? "")) return actionResult("release.publish", { kind: "Target", targetKind: "release", label: `${repo} ${firstPositional(rest) ?? ""}`.trim() }, text);
	if (group === "secret" && ["set", "delete", "remove"].includes(verb ?? "")) return actionResult("credential.change", { kind: "Target", targetKind: "secret", label: `${repo} ${firstPositional(rest) ?? ""}`.trim() }, text);
	if (group === "auth" && ["login", "logout", "refresh", "token", "setup-git"].includes(verb ?? "")) return actionResult("credential.change", { kind: "Target", targetKind: "gh-auth", label: verb ?? "" }, text);
	if (group === "repo" && verb === "delete") return actionResult("data.delete", { kind: "Target", targetKind: "repository", label: firstPositional(rest) ?? repo }, text);
	if (group === "repo" && ["create", "fork", "rename", "archive", "edit"].includes(verb ?? "")) return opaque(text, `gh repo ${verb} changes remote repository settings`);
	if ((group === "workflow" && verb === "run") || (group === "run" && verb === "rerun")) return opaque(text, "starts a remote workflow");
	if (group === "api") return classifyGitHubApi(apiRequest(args.slice(1)), repo, text);
	return result();
}

interface ApiRequest {
	method: string;
	path: string;
	body: string;
}

function apiRequest(args: string[]): ApiRequest {
	let method = "";
	let hasFields = false;
	let path = "";
	let body = "";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-X" || arg === "--method") {
			method = (args[++i] ?? "").toUpperCase();
			continue;
		}
		if (arg.startsWith("--method=")) {
			method = arg.slice(9).toUpperCase();
			continue;
		}
		if (["-f", "-F", "--field", "--raw-field", "--input"].includes(arg)) {
			hasFields = true;
			body += ` ${args[++i] ?? ""}`;
			continue;
		}
		if (["-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "--cache"].includes(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-") && !path) path = arg;
	}
	return { method: method || (hasFields ? "POST" : "GET"), path, body };
}

function classifyGitHubApi(request: ApiRequest, fallbackRepo: string, text: string): CommandClassification {
	const { method, path } = request;
	if (path === "graphql") return /\bmutation\b/.test(request.body) ? opaque(text, "GraphQL mutation") : result();
	if (method === "GET" || method === "HEAD") return result();
	const clean = path.replace(/^https?:\/\/api\.github\.com/, "").replace(/^\//, "").split("?")[0];
	const repoMatch = /^repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(clean);
	const repo = repoMatch ? `github.com/${repoMatch[1]}` : fallbackRepo;
	const tail = repoMatch?.[2] ?? "";
	let m: RegExpExecArray | null;
	if ((m = /^\/(issues|pulls)\/(\d+)\/(comments|reviews)$/.exec(tail)) && method === "POST")
		return actionResult("comment.post", { kind: "Recipient", recipientKind: "unknown", label: `${repo}:${m[1] === "issues" ? "issue" : "pr"}#${m[2]}` }, text);
	if ((m = /^\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(tail)) && method === "POST")
		return actionResult("comment.post", { kind: "Recipient", recipientKind: "unknown", label: `${repo}:comment#${m[2]}` }, text);
	if ((m = /^\/issues\/comments\/(\d+)$/.exec(tail)) && method === "PATCH")
		return actionResult("comment.post", { kind: "Recipient", recipientKind: "unknown", label: `${repo}:comment#${m[1]}` }, text);
	if ((m = /^\/pulls\/(\d+)\/merge$/.exec(tail)) && method === "PUT")
		return actionResult("pr.merge", { kind: "PullRequest", number: Number(m[1]), headSha: "", repo }, text);
	if ((m = /^\/statuses\/([^/]+)$|^\/check-runs$/.exec(tail)) && method === "POST" && /agentic\/verdict/.test(request.body))
		return actionResult("verdict.forge", { kind: "PullRequest", number: 0, headSha: m[1] ?? "", repo }, text);
	if (/^\/releases(\/|$)/.test(tail)) return actionResult("release.publish", { kind: "Target", targetKind: "release", label: repo }, text);
	if (/^\/actions\/secrets\//.test(tail)) return actionResult("credential.change", { kind: "Target", targetKind: "secret", label: repo }, text);
	if (tail === "" && method === "DELETE" && repoMatch) return actionResult("data.delete", { kind: "Target", targetKind: "repository", label: repo }, text);
	return opaque(text, `GitHub API ${method} ${clean} is not recognized`);
}

function classifyHttpClient(name: string, args: string[], ctx: ClassifyContext, text: string): CommandClassification {
	let method = "";
	let hasData = false;
	let url = "";
	const dataFlags = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "--json", "-T", "--upload-file", "--post-data", "--post-file", "--body-data", "--body-file"]);
	const valueFlags = new Set(["-H", "--header", "-o", "--output", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "--connect-timeout", "-m", "--max-time", "-w", "--write-out", "--retry", "-O"]);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-X" || arg === "--request" || arg === "--method") {
			method = (args[++i] ?? "").toUpperCase();
			continue;
		}
		if (/^-X[A-Z]+$/.test(arg)) {
			method = arg.slice(2);
			continue;
		}
		if (arg.startsWith("--method=")) {
			method = arg.slice(9).toUpperCase();
			continue;
		}
		if (dataFlags.has(arg) || [...dataFlags].some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))) {
			hasData = true;
			if (!arg.includes("=")) i++;
			continue;
		}
		if (arg === "--url") {
			url = args[++i] ?? "";
			continue;
		}
		if (valueFlags.has(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-") && !url) url = arg;
	}
	if (name === "http" || name === "https") {
		const verbs = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
		const positional = args.filter((arg) => !arg.startsWith("-"));
		if (verbs.includes((positional[0] ?? "").toUpperCase())) {
			method = positional[0].toUpperCase();
			url = positional[1] ?? "";
		}
		if (positional.slice(2).some((arg) => /[:=]/.test(arg))) hasData = true;
	}
	const effective = method || (hasData ? "POST" : "GET");
	if (effective === "GET" || effective === "HEAD") return result();
	let host = "";
	let path = "";
	try {
		const parsed = new URL(url.includes("://") ? url : `https://${url}`);
		host = parsed.host;
		path = parsed.pathname;
	} catch {
		return opaque(text, `${name} ${effective} to an unreadable URL`);
	}
	if (host === "api.github.com") return classifyGitHubApi({ method: effective, path, body: "" }, repoIdentity(ctx.remoteUrl(ctx.cwd, "origin") ?? "origin"), text);
	return opaque(text, `${name} ${effective} to ${host}`);
}
