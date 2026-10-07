/**
 * Protected configuration paths. An agent that can edit these could raise its own ceiling,
 * rewrite the policies, forge a verdict, rewrite its decision trail, or change forge state,
 * so writes to them are hard-point actions (file.write) decided by Cedar. Reads stay allowed.
 *
 * Kinds: grants, user-config, global-policy, ledger, decision-log, forge (blocked); enforcement,
 * repo-policy, learned (ask the user). Enforcement covers what wires the gate in: the policy layer's
 * own code and dependencies, the Pi gate extension, and harness settings that could drop the hook
 * or point it at other grants. Same-user processes can still bypass this with code the classifier cannot
 * read; real isolation needs a separate agent identity or a sandbox (design O4).
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { configPath } from "./config.ts";
import { grantsPath, orchStore } from "./facts.ts";

export type ProtectedKind = "grants" | "user-config" | "global-policy" | "ledger" | "decision-log" | "forge" | "enforcement" | "repo-policy" | "learned";

/** Most severe first: when one write touches several protected paths, the blocked kind wins. */
const SEVERITY: ProtectedKind[] = ["grants", "user-config", "global-policy", "ledger", "decision-log", "forge", "enforcement", "repo-policy", "learned"];

/**
 * How far a write reaches. "path": the candidate and everything under it. "parent": also a
 * directory that directly contains a protected path (a copy into it can replace the file).
 * "ancestor": any directory above one (moving or removing it takes the protected path along).
 */
export type Reach = "path" | "parent" | "ancestor" | "checkout";

export interface ProtectedPath {
	kind: ProtectedKind;
	path: string;
	/** A git checkout: only commands that rewrite its working tree (reach "checkout") match. */
	checkout?: boolean;
	/** A symlink whose own location matters (the hook's path to the gate), kept unresolved. */
	link?: boolean;
}

/**
 * Automounted roots where any filesystem call can block indefinitely (macOS autofs maps /home
 * and /net; /Network is the network browse root). Paths under them are compared lexically and
 * never touched, because a blocking synchronous call would stall the hook or the agent.
 */
const AUTOMOUNT_ROOTS = process.platform === "darwin" ? ["/home", "/net", "/Network"] : [];

export function isAutomountPath(path: string): boolean {
	const absolute = resolve(path);
	return AUTOMOUNT_ROOTS.some((root) => absolute === root || absolute.startsWith(`${root}/`));
}

/** Resolves symlinks for the existing part of a path, so a link cannot hide a protected target. */
export function canonical(path: string): string {
	if (isAutomountPath(path)) return resolve(path);
	let current = resolve(path);
	const rest: string[] = [];
	while (!existsSync(current) && dirname(current) !== current) {
		rest.unshift(current.slice(dirname(current).length + 1));
		current = dirname(current);
	}
	try {
		current = realpathSync(current);
	} catch {
		return resolve(path);
	}
	return rest.length > 0 ? join(current, ...rest) : current;
}

export function protectedPaths(env: NodeJS.ProcessEnv, repoRoot: string | undefined, globalPolicyDir: string | undefined): ProtectedPath[] {
	const paths: ProtectedPath[] = [
		{ kind: "grants", path: grantsPath(env) },
		{ kind: "user-config", path: configPath(env) },
	];
	if (globalPolicyDir) paths.push({ kind: "global-policy", path: globalPolicyDir });
	const store = orchStore(repoRoot, env);
	if (store) paths.push({ kind: "ledger", path: store });
	if (env.AGENTIC_DECISION_LOG) paths.push({ kind: "decision-log", path: env.AGENTIC_DECISION_LOG });
	if (env.AGENTIC_FORGE) paths.push({ kind: "forge", path: env.AGENTIC_FORGE });
	const home = env.HOME ?? homedir();
	if (globalPolicyDir) {
		const agenticRoot = dirname(globalPolicyDir);
		const kitRoot = dirname(agenticRoot);
		paths.push({ kind: "enforcement", path: agenticRoot });
		for (const file of [join("pi", "extensions", "agentic-policy-gate.ts"), "node_modules", "package.json", "bun.lock"]) paths.push({ kind: "enforcement", path: join(kitRoot, file) });
		paths.push({ kind: "enforcement", path: kitRoot, checkout: true });
	}
	// Claude's hook command and Pi's package path reach the gate through bootstrap's link.
	paths.push({ kind: "enforcement", path: join(env.BOOTSTRAP_ROOT ?? join(home, ".local", "share", "bootstrap"), "tools", "agent-kit"), link: true });
	const claudeHome = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
	for (const file of ["settings.json", "settings.local.json"]) paths.push({ kind: "enforcement", path: join(claudeHome, file) });
	paths.push({ kind: "enforcement", path: join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "settings.json") });
	paths.push({ kind: "enforcement", path: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "bootstrap") });
	if (repoRoot) {
		for (const file of [join(".claude", "settings.json"), join(".claude", "settings.local.json"), join(".pi", "settings.json")]) paths.push({ kind: "enforcement", path: join(repoRoot, file) });
		paths.push({ kind: "repo-policy", path: join(repoRoot, ".agents", "policy") });
		for (const file of ["state.json", "LEARNED.md", "proposed-global.md", "backlog.json"]) paths.push({ kind: "learned", path: join(repoRoot, ".agents", "learning", file) });
	}
	return paths.map((entry) => ({ ...entry, path: entry.link ? join(canonical(dirname(entry.path)), basename(entry.path)) : canonical(entry.path) }));
}

export interface KindOptions {
	/** Expands ~ the way shells and Pi's file tools do. */
	home?: string;
	reach?: Reach;
}

/**
 * Returns the most severe protected kind a write to the candidate reaches, or undefined.
 * Relative paths resolve against cwd; a leading ~ expands to home.
 */
export function protectedKindOf(paths: ProtectedPath[], cwd: string, candidate: string, options: KindOptions = {}): ProtectedKind | undefined {
	if (candidate.length === 0) return undefined;
	const home = options.home ?? homedir();
	const expanded = candidate === "~" ? home : candidate.startsWith("~/") ? join(home, candidate.slice(2)) : candidate;
	const absolute = canonical(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	const inside = absolute.endsWith("/") ? absolute : `${absolute}/`;
	const reach = options.reach ?? "path";
	const hits = paths.filter(
		(entry) =>
			entry.checkout ? reach === "checkout" && (absolute === entry.path || absolute.startsWith(`${entry.path}/`)) :
			absolute === entry.path ||
			absolute.startsWith(`${entry.path}/`) ||
			(reach === "parent" && dirname(entry.path) === absolute) ||
			(reach === "ancestor" && entry.path.startsWith(inside)),
	);
	return hits.map((entry) => entry.kind).sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0];
}
