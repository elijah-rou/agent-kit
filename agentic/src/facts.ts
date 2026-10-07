import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { repoIdentity, type ClassifyContext } from "./classifier.ts";
import { agenticHome } from "./config.ts";
import { isAutomountPath } from "./protected.ts";
import type { ClassifiedAction, Facts } from "./types.ts";

/** Where the user's grants live. Outside every repository, so an agent cannot raise its own ceiling. */
export function grantsPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTIC_GRANTS ?? join(agenticHome(env), "grants.toml");
}

export interface Grant {
	repo: string;
	level: number;
}

function parseLevel(value: unknown, where: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4) throw new Error(`${where}: level must be an integer from 0 to 4`);
	return value;
}

/** Strict parse; a malformed grants file is an error, which the adapters turn into a denial. */
export function readGrants(path: string): Grant[] {
	if (!existsSync(path)) return [];
	const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { grant?: unknown };
	if (parsed.grant === undefined) return [];
	if (!Array.isArray(parsed.grant)) throw new Error(`${path}: grant must be an array of tables`);
	return parsed.grant.map((entry, index) => {
		const row = entry as { repo?: unknown; level?: unknown };
		if (typeof row.repo !== "string" || row.repo.length === 0) throw new Error(`${path}: grant[${index}].repo must be a string`);
		return { repo: repoIdentity(row.repo), level: parseLevel(row.level, `${path}: grant[${index}]`) };
	});
}

export interface RepoConfig {
	requestedLevel?: number;
	posture?: "prevention" | "recovery";
	policyDir?: string;
}

/** Reads `.agents/autonomy.toml`. A repository can request a level; it can never exceed the grant. */
export function readRepoConfig(repoRoot: string | undefined): RepoConfig {
	if (!repoRoot) return {};
	const file = join(repoRoot, ".agents", "autonomy.toml");
	const policyDir = join(repoRoot, ".agents", "policy");
	const config: RepoConfig = { policyDir: existsSync(policyDir) ? policyDir : undefined };
	if (!existsSync(file)) return config;
	const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as { level?: unknown; posture?: unknown };
	if (parsed.level !== undefined) config.requestedLevel = parseLevel(parsed.level, file);
	if (parsed.posture !== undefined) {
		if (parsed.posture !== "prevention" && parsed.posture !== "recovery") throw new Error(`${file}: posture must be "prevention" or "recovery"`);
		config.posture = parsed.posture;
	}
	return config;
}

/** effective = min(grant, max(repo request, session raise)); a raise lifts within the grant only. */
export function effectiveLevel(grant: number, requested: number | undefined, sessionRaise: number): number {
	const base = requested === undefined ? grant : Math.min(requested, grant);
	return Math.min(grant, Math.max(base, sessionRaise));
}

export type VerdictValue = "live-ui-verified" | "unit-test-verified" | "type-check-only" | "verifier-blocked" | "verifier-failed";
export const PASSING: ReadonlySet<string> = new Set(["live-ui-verified", "unit-test-verified"]);

export interface LedgerRow {
	pr: number;
	sha: string;
	verdict: string;
	verifier: string;
}

/** Reads the vendored orch store's ledger.tsv (header: pr sha verdict evidence verifier ts). */
export function readLedger(store: string | undefined): LedgerRow[] {
	if (!store) return [];
	const file = join(store, "ledger.tsv");
	if (!existsSync(file)) return [];
	const [header, ...rows] = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
	if (header !== "pr\tsha\tverdict\tevidence\tverifier\tts") throw new Error(`${file}: unexpected ledger header`);
	return rows.map((line) => {
		const [pr, sha, verdict, , verifier] = line.split("\t");
		return { pr: Number(pr.replace(/^#/, "")), sha, verdict, verifier };
	});
}

/** Read-only forge queries. The default implementation uses `gh`; scenarios substitute a shim. */
/** Which session pushed which branch: the authors a verdict must not come from. */
export interface PushRow {
	repo: string;
	branch: string;
	principal: string;
}

const PUSHES_HEADER = "repo\tbranch\tprincipal\tts";

/** The gate's own record of pushes, under the protected user state directory. */
export function pushesPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agenticHome(env), "state", "pushes.tsv");
}

export function readPushes(env: NodeJS.ProcessEnv = process.env): PushRow[] {
	const file = pushesPath(env);
	if (!existsSync(file)) return [];
	const [header, ...rows] = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
	if (header !== PUSHES_HEADER) throw new Error(`${file}: unexpected header`);
	return rows.map((line) => {
		const [repo, branch, principal] = line.split("\t");
		return { repo, branch, principal };
	});
}

/** Appends the pushes a proceeding tool call makes, so later verdicts can exclude their author. */
export function recordPushes(env: NodeJS.ProcessEnv, principal: string, pushes: readonly { repo: string; branch: string }[]): void {
	if (pushes.length === 0) return;
	const file = pushesPath(env);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const header = existsSync(file) ? "" : `${PUSHES_HEADER}\n`;
	appendFileSync(file, header + pushes.map((push) => `${push.repo}\t${push.branch}\t${principal}\t${new Date().toISOString()}\n`).join(""), { mode: 0o600 });
}

export interface ForgeReader {
	prHead(repo: string, pr: number): { headSha: string; baseRef: string; headRef?: string } | undefined;
	recipientKind(label: string): "person" | "bot" | "unknown";
}

function gh(args: string[], cwd: string): string | undefined {
	try {
		return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
	} catch {
		return undefined;
	}
}

function ghRepoArg(repo: string): string {
	return repo.replace(/^github\.com\//, "");
}

export function ghForgeReader(cwd: string): ForgeReader {
	return {
		prHead(repo, pr) {
			const out = gh(["pr", "view", String(pr), "-R", ghRepoArg(repo), "--json", "headRefOid,baseRefName,headRefName"], cwd);
			if (!out) return undefined;
			try {
				const parsed = JSON.parse(out) as { headRefOid?: string; baseRefName?: string; headRefName?: string };
				return parsed.headRefOid ? { headSha: parsed.headRefOid, baseRef: parsed.baseRefName ?? "", headRef: parsed.headRefName } : undefined;
			} catch {
				return undefined;
			}
		},
		recipientKind(label) {
			const match = /^(.*):(pr|issue|comment)#(\d+)$/.exec(label);
			if (!match) return "unknown";
			const [, repo, kind, id] = match;
			const path =
				kind === "comment"
					? `repos/${ghRepoArg(repo)}/pulls/comments/${id}`
					: `repos/${ghRepoArg(repo)}/issues/${id}`;
			const type = gh(["api", path, "--jq", ".user.type"], cwd);
			if (type === "Bot") return "bot";
			if (type === "User" || type === "Organization") return "person";
			return "unknown";
		},
	};
}

export function gitContext(cwd: string): ClassifyContext {
	const git = (args: string[], at: string): string | undefined => {
		try {
			return execFileSync("git", ["-C", at, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || undefined;
		} catch {
			return undefined;
		}
	};
	return {
		cwd,
		repoRoot: git(["rev-parse", "--show-toplevel"], cwd),
		homeDir: homedir(),
		currentBranch: (at) => git(["symbolic-ref", "--quiet", "--short", "HEAD"], at),
		remoteUrl: (at, remote) => git(["remote", "get-url", remote], at),
		defaultBranch: (at, remote) => git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], at)?.replace(`${remote}/`, ""),
		readFile: (path) => {
			if (isAutomountPath(path)) return undefined;
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		env: process.env,
	};
}

export interface SessionFacts {
	principalId: string;
	isChild: boolean;
	sessionRaise: number;
	harness: string;
}

/** Child detection: Pi subagents set PI_SUBAGENT_CHILD; AGENTIC_CHILD marks other children (the Claude hook sets it for agent_id calls). */
export function sessionFromEnv(env: NodeJS.ProcessEnv, harness: string): SessionFacts {
	const isChild = ["1", "true"].includes(env.PI_SUBAGENT_CHILD ?? "") || ["1", "true"].includes(env.AGENTIC_CHILD ?? "");
	const raise = env.AGENTIC_SESSION_RAISE === undefined ? 0 : Number(env.AGENTIC_SESSION_RAISE);
	return {
		principalId: env.AGENTIC_AGENT_ID ?? `${harness}-${process.pid}`,
		isChild,
		sessionRaise: Number.isInteger(raise) && raise >= 0 && raise <= 4 ? raise : 0,
		harness,
	};
}

export interface FactInputs {
	grants: Grant[];
	repoConfig: RepoConfig;
	session: SessionFacts;
	ledger: LedgerRow[];
	forge: ForgeReader;
	pushes?: PushRow[];
}

function repoOfAction(action: ClassifiedAction): string | undefined {
	const resource = action.resource;
	if (resource.kind === "Branch" || resource.kind === "PullRequest") return resource.repo;
	if (resource.kind === "Repo") return resource.origin;
	if (resource.kind === "Recipient") return resource.label.split(":")[0];
	return undefined;
}

/**
 * Builds the Cedar context for one action and fills resource facts the classifier cannot know:
 * a PR's head SHA and base, and a comment recipient's kind. Repos with no grant get level 0.
 */
export function factsFor(action: ClassifiedAction, inputs: FactInputs, workspaceRepo: string | undefined): { facts: Facts; action: ClassifiedAction } {
	const repo = repoOfAction(action) ?? workspaceRepo;
	const grant = inputs.grants.find((candidate) => candidate.repo === repo)?.level ?? 0;
	const level = effectiveLevel(grant, inputs.repoConfig.requestedLevel, inputs.session.sessionRaise);
	const facts: Facts = {
		userGrant: grant,
		requestedLevel: inputs.repoConfig.requestedLevel ?? grant,
		sessionRaise: inputs.session.sessionRaise,
		effectiveLevel: level,
		force: action.force,
		verdict: "none",
		verdictSha: "",
		isFrontier: false,
		isAuthor: false,
	};
	let filled = action;
	if (action.resource.kind === "PullRequest") {
		const head = action.resource.number > 0 ? inputs.forge.prHead(action.resource.repo, action.resource.number) : undefined;
		const headSha = head?.headSha ?? "";
		filled = { ...action, resource: { ...action.resource, headSha } };
		const row = [...inputs.ledger].reverse().find((entry) => entry.pr === action.resource.number && entry.sha === headSha);
		if (row && PASSING.has(row.verdict) && row.verifier !== inputs.session.principalId) {
			facts.verdict = "pass";
			facts.verdictSha = row.sha;
		} else if (row) {
			facts.verdict = row.verifier === inputs.session.principalId ? "self-verified" : row.verdict;
			facts.verdictSha = row.sha;
		}
		facts.isFrontier = head !== undefined && (head.baseRef === "main" || head.baseRef === "master");
		const pr = action.resource;
		facts.isAuthor = head?.headRef !== undefined && (inputs.pushes ?? []).some((push) => push.repo === pr.repo && push.branch === head.headRef && push.principal === inputs.session.principalId);
	}
	if (action.resource.kind === "Recipient" && action.resource.recipientKind === "unknown") {
		filled = { ...action, resource: { ...action.resource, recipientKind: inputs.forge.recipientKind(action.resource.label) } };
	}
	return { facts, action: filled };
}

export function orchStore(repoRoot: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.AGENTIC_ORCH_STORE) return env.AGENTIC_ORCH_STORE;
	return repoRoot ? join(repoRoot, ".agents", "orch") : undefined;
}

export { dirname };
