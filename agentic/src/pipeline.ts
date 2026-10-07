import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { append as appendDecisionRow } from "../tools/decision-log/decision-log.ts";
import { classifyCommand, repoIdentity, type ClassifyContext, type UnclassifiedPart } from "./classifier.ts";
import { authorize, loadPolicySet, validatePolicySet } from "./engine.ts";
import { protectedKindOf, protectedPaths } from "./protected.ts";
import { factsFor, ghForgeReader, gitContext, grantsPath, orchStore, readGrants, readLedger, readRepoConfig, type ForgeReader, type SessionFacts } from "./facts.ts";
import type { ClassifiedAction, Decision, PolicyDecision } from "./types.ts";

declare const __dirname: string | undefined;

/**
 * Resolves the agentic root (agent-kit/agentic) at call time. Pi's extension loader evaluates
 * modules from a data: URL, which breaks import.meta.dir; its CommonJS wrapper still provides
 * the real __dirname, as Bun does. AGENTIC_ROOT overrides both. Resolution failure throws
 * inside the pipeline's fail-closed handling, never at module load, so the gate stays loaded.
 */
export function agenticRoot(env: NodeJS.ProcessEnv = process.env): string {
	if (env.AGENTIC_ROOT) return env.AGENTIC_ROOT;
	const candidates = [typeof __dirname === "string" ? __dirname : undefined, import.meta.dir];
	const here = candidates.find((dir) => dir !== undefined && !dir.includes("data:") && existsSync(join(dir, "..", "policy", "schema.cedarschema")));
	if (!here) throw new Error("cannot resolve the policy directory; set AGENTIC_ROOT");
	return join(here, "..");
}

export const schemaPath = (env?: NodeJS.ProcessEnv) => join(agenticRoot(env), "policy", "schema.cedarschema");
export const globalPolicyDir = (env?: NodeJS.ProcessEnv) => join(agenticRoot(env), "policy");

/** Answer from the optional Jev friction filter for one unreadable command. */
export type JevVerdict =
	| { kind: "confident-no"; probability: number }
	| { kind: "yes-or-uncertain"; probability: number }
	| { kind: "unavailable"; reason: string };

export type JevFilter = (command: string) => Promise<JevVerdict>;

const policyCache = new Map<string, { loaded: ReturnType<typeof loadPolicySet>; validation: string[] }>();

function dirStamp(dir: string | undefined): string {
	if (!dir || !existsSync(dir)) return "-";
	return readdirSync(dir)
		.filter((name) => name.endsWith(".cedar"))
		.sort()
		.map((name) => `${name}:${statSync(join(dir, name)).mtimeMs}:${statSync(join(dir, name)).size}`)
		.join(",");
}

/**
 * Loads and validates the policy set, cached per process by the schema text and every policy
 * file's name, mtime, and size. Long-lived adapters (the Pi extension) skip re-validation;
 * any change to a policy file or the schema invalidates the entry.
 */
function loadValidated(schema: string, globalDir: string, repoDir: string | undefined) {
	const key = `${Bun.hash(schema)}|${globalDir}|${dirStamp(globalDir)}|${repoDir ?? "-"}|${dirStamp(repoDir)}`;
	const cached = policyCache.get(key);
	if (cached) return cached;
	const loaded = loadPolicySet(globalDir, repoDir);
	const entry = { loaded, validation: loaded.errors.length > 0 ? [] : validatePolicySet(schema, loaded.policies) };
	policyCache.set(key, entry);
	return entry;
}

export interface ToolCall {
	toolName: string;
	input: unknown;
	cwd: string;
}

export interface PipelineDeps {
	session: SessionFacts;
	env: NodeJS.ProcessEnv;
	classifyContext?: ClassifyContext;
	forge?: ForgeReader;
	jev?: JevFilter;
}

export interface StepResult {
	kind: "action" | "unclassified";
	summary: string;
	decision: Decision;
	policies: string[];
	reason: string;
	jev?: JevVerdict;
}

export interface PipelineResult {
	decision: Decision;
	steps: StepResult[];
	reason: string;
	policies: string[];
	outsidePolicy: boolean;
}

const SHELL_TOOLS = new Set(["bash", "Bash", "shell", "run_shell_command"]);
const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

function combine(steps: StepResult[]): Decision {
	return steps.reduce<Decision>((worst, step) => (RANK[step.decision] > RANK[worst] ? step.decision : worst), "allow");
}

function deny(reason: string): PipelineResult {
	return { decision: "deny", steps: [], reason, policies: [], outsidePolicy: false };
}

function describe(action: ClassifiedAction): string {
	const r = action.resource;
	const target =
		r.kind === "Branch"
			? `${r.repo}#${r.name}`
			: r.kind === "PullRequest"
				? `${r.repo}#pr${r.number}`
				: r.kind === "Repo"
					? r.origin
					: r.kind === "Recipient"
						? `${r.label} (${r.recipientKind})`
						: r.kind === "ProtectedPath"
							? `${r.protectedKind} file ${r.path}`
							: `${r.targetKind}:${r.label}`;
	return `${action.action} ${target}${action.force ? " (force)" : ""}`;
}

/**
 * Runs one tool call through classify, Jev filter, facts, Cedar, and combine. Any error in
 * configuration or policy loading fails closed to deny: the adapters rely on that.
 */
const FILE_TOOLS: Record<string, string[]> = {
	edit: ["path", "file_path"],
	write: ["path", "file_path"],
	Edit: ["file_path"],
	Write: ["file_path"],
	MultiEdit: ["file_path"],
	NotebookEdit: ["notebook_path"],
};

export async function evaluateToolCall(call: ToolCall, deps: PipelineDeps): Promise<PipelineResult> {
	const isShell = SHELL_TOOLS.has(call.toolName);
	const fileKeys = FILE_TOOLS[call.toolName];
	if (!isShell && !fileKeys) return { decision: "allow", steps: [], reason: "not a shell or file-writing tool; outside policy", policies: [], outsidePolicy: true };

	const base = deps.classifyContext ?? gitContext(call.cwd);
	let protectedList;
	try {
		protectedList = protectedPaths(deps.env, base.repoRoot, globalPolicyDir(deps.env));
	} catch (error) {
		return deny(`policy configuration error: ${(error as Error).message}`);
	}
	const ctx: ClassifyContext = { ...base, env: deps.env, protectedKind: (path) => protectedKindOf(protectedList, base.cwd, path) };

	let classification;
	if (isShell) {
		const command = (call.input as { command?: unknown })?.command;
		if (typeof command !== "string") return deny("shell tool call without a command string");
		classification = classifyCommand(command, ctx);
	} else {
		const input = call.input as Record<string, unknown>;
		const path = fileKeys.map((key) => input?.[key]).find((value): value is string => typeof value === "string");
		if (!path) return deny(`${call.toolName} call without a path`);
		const kind = ctx.protectedKind?.(path);
		classification = kind ? { actions: [{ action: "file.write" as const, resource: { kind: "ProtectedPath" as const, protectedKind: kind, path }, force: false, evidence: `${call.toolName} ${path}` }], unclassified: [] } : { actions: [], unclassified: [] };
	}
	const reachable = classification.unclassified.filter((part) => part.couldReachHardPoint);
	if (classification.actions.length === 0 && reachable.length === 0) {
		return { decision: "allow", steps: [], reason: "no hard-point actions; outside policy", policies: [], outsidePolicy: true };
	}

	let schema: string;
	let grants;
	let repoConfig;
	let policyDir: string;
	try {
		schema = readFileSync(schemaPath(deps.env), "utf8");
		policyDir = globalPolicyDir(deps.env);
		grants = readGrants(grantsPath(deps.env));
		repoConfig = readRepoConfig(ctx.repoRoot);
	} catch (error) {
		return deny(`policy configuration error: ${(error as Error).message}`);
	}
	const { loaded, validation } = loadValidated(schema, policyDir, repoConfig.policyDir);
	if (loaded.errors.length > 0) return deny(`policy load error: ${loaded.errors.join("; ")}`);
	if (validation.length > 0) return deny(`policy validation error: ${validation.join("; ")}`);

	let ledger;
	try {
		ledger = readLedger(orchStore(ctx.repoRoot, deps.env));
	} catch (error) {
		return deny(`verdict ledger error: ${(error as Error).message}`);
	}
	const forge = deps.forge ?? ghForgeReader(call.cwd);
	const origin = ctx.remoteUrl(ctx.cwd, "origin");
	const workspaceRepo = origin ? repoIdentity(origin) : undefined;
	const steps: StepResult[] = [];

	for (const action of classification.actions) {
		const { facts, action: filled } = factsFor(action, { grants, repoConfig, session: deps.session, ledger, forge }, workspaceRepo);
		const result: PolicyDecision = authorize(schema, loaded.policies, { id: deps.session.principalId, isChild: deps.session.isChild, harness: deps.session.harness }, filled, facts);
		steps.push({ kind: "action", summary: `${describe(filled)} at A${facts.effectiveLevel}`, decision: result.decision, policies: result.policies, reason: result.reason });
	}

	for (const part of reachable) steps.push(await filterUnclassified(part, deps.jev, deps.session.isChild));

	const decision = combine(steps);
	const decisive = steps.filter((step) => step.decision === decision);
	return {
		decision,
		steps,
		reason: decisive.map((step) => `${step.summary}: ${step.reason}`).join(" | "),
		policies: [...new Set(decisive.flatMap((step) => step.policies))],
		outsidePolicy: false,
	};
}

async function filterUnclassified(part: UnclassifiedPart, jev: JevFilter | undefined, isChild: boolean): Promise<StepResult> {
	const base = { kind: "unclassified" as const, summary: `unreadable command (${part.reason})`, policies: [] };
	if (isChild) return { ...base, decision: "deny", reason: "child agents may not run unreadable commands that could publish" };
	if (part.opaqueExecution) return { ...base, decision: "ask", reason: "executes computed or piped-in text; asked directly without Jev" };
	if (!jev) return { ...base, decision: "ask", reason: "could reach a hard point; Jev filter not configured" };
	const verdict = await jev(part.text);
	if (verdict.kind === "confident-no") return { ...base, decision: "allow", reason: `Jev: confident no (p=${verdict.probability.toFixed(3)})`, jev: verdict };
	if (verdict.kind === "unavailable") return { ...base, decision: "ask", reason: `Jev unavailable (${verdict.reason})`, jev: verdict };
	return { ...base, decision: "ask", reason: `Jev: may reach a hard point (p=${verdict.probability.toFixed(3)})`, jev: verdict };
}

/** Appends one row to the run's decision log (tools/decision-log) when AGENTIC_DECISION_LOG names one. */
export function recordDecision(env: NodeJS.ProcessEnv, command: string, result: PipelineResult): void {
	const log = env.AGENTIC_DECISION_LOG;
	if (!log || result.outsidePolicy) return;
	appendDecisionRow(
		log,
		{
			phase: "policy",
			decision: `${result.decision}: ${command.slice(0, 200)}`,
			why: result.reason.slice(0, 500) || "none",
			evidence: result.policies.join(",") || "none",
			result: result.decision,
		},
		new Date(),
	);
}

export function validateAll(repoRoot: string | undefined): string[] {
	const schema = readFileSync(schemaPath(), "utf8");
	const config = readRepoConfig(repoRoot);
	const loaded = loadPolicySet(globalPolicyDir(), config.policyDir);
	return [...loaded.errors, ...validatePolicySet(schema, loaded.policies)];
}
