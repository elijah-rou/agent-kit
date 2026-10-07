/**
 * Protected configuration paths. An agent that can edit these could raise its own ceiling,
 * rewrite the policies, forge a verdict, rewrite its decision trail, or change forge state,
 * so writes to them are hard-point actions (file.write) decided by Cedar. Reads stay allowed.
 *
 * Kinds: grants, user-config, global-policy, ledger, decision-log, forge (blocked); repo-policy, learned
 * (ask the user). Same-user processes can still bypass this with code the classifier cannot
 * read; real isolation needs a separate agent identity or a sandbox (design O4).
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configPath } from "./config.ts";
import { grantsPath, orchStore } from "./facts.ts";

export type ProtectedKind = "grants" | "user-config" | "global-policy" | "ledger" | "decision-log" | "forge" | "repo-policy" | "learned";

export interface ProtectedPath {
	kind: ProtectedKind;
	path: string;
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
	if (repoRoot) {
		paths.push({ kind: "repo-policy", path: join(repoRoot, ".agents", "policy") });
		for (const file of ["state.json", "LEARNED.md", "proposed-global.md", "backlog.json"]) paths.push({ kind: "learned", path: join(repoRoot, ".agents", "learning", file) });
	}
	return paths.map((entry) => ({ ...entry, path: canonical(entry.path) }));
}

/** Returns the protected kind of a path, or undefined. Relative paths resolve against cwd. */
export function protectedKindOf(paths: ProtectedPath[], cwd: string, candidate: string): ProtectedKind | undefined {
	if (candidate.length === 0) return undefined;
	const absolute = canonical(isAbsolute(candidate) ? candidate : resolve(cwd, candidate));
	const hit = paths.find((entry) => absolute === entry.path || absolute.startsWith(`${entry.path}/`));
	return hit?.kind;
}
