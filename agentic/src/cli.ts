/**
 * The agentic stack CLI, loaded by bin/agentic. Policy subcommands:
 *   check           read {"toolName","input","cwd"} JSON on stdin, print the decision JSON
 *   claude-hook     Claude Code PreToolUse adapter: Claude hook JSON in, hook decision JSON out
 *   explain <cmd>   classify and evaluate a shell command in the current directory
 *   validate        validate global and repo policies against the schema
 *   status [--json] the effective autonomy level for the current repository and its inputs
 * Tool subcommands pass their arguments through to the tool's own CLI (each has --help):
 *   decision-log      append-only decision trail (tools/decision-log)
 *   feature-map-lint  validate a verification skill's feature map (tools/feature-map-lint)
 *   report-lint       check a final report against the interaction contract (tools/report-lint)
 *   rule-table        check rules.toml and find instructions that restate enforced rules (tools/rule-table)
 *   rulesets          plan or apply the GitHub ruleset that backstops the gate (tools/rulesets)
 *   upstream-drift    report upstream changes since each adapted skill's or vendored tool's commit (tools/upstream-drift)
 *   orch              program store and verdict ledger, vendored from pstack (vendor/orch)
 *   watch-pr          pull request and stack watcher, vendored from pstack (vendor/watch-pr)
 *   learning          learning loop: consolidate, approve, status (src/learning)
 */
import { evaluateToolCall, recordDecision, validateAll, type JevFilter, type PipelineResult } from "./pipeline.ts";
import { effectiveLevel, gitContext, grantsPath, readGrants, readRepoConfig, sessionFromEnv } from "./facts.ts";
import { repoIdentity } from "./classifier.ts";
import { jevFilterFromConfig } from "./jev-filter.ts";
import { readConfig, typesafeKey } from "./config.ts";
import { join } from "node:path";

const TOOLS: Record<string, string> = {
	"decision-log": "tools/decision-log/cli.ts",
	"feature-map-lint": "tools/feature-map-lint/cli.ts",
	"report-lint": "tools/report-lint/cli.ts",
	"rule-table": "tools/rule-table/cli.ts",
	rulesets: "tools/rulesets/cli.ts",
	"upstream-drift": "tools/upstream-drift/cli.ts",
	orch: "vendor/orch/orch.ts",
	"watch-pr": "vendor/watch-pr/watch-pr",
	learning: "src/learning/cli.ts",
};

const HOOK_DEADLINE_MS = Number(process.env.AGENTIC_HOOK_DEADLINE_MS ?? 8000);

async function readStdin(): Promise<string> {
	return await new Response(Bun.stdin.stream()).text();
}

function usage(code: number): never {
	console.error(`usage: agentic check | claude-hook | explain <command> | validate | status [--json] | ${Object.keys(TOOLS).join(" | ")} [args]`);
	process.exit(code);
}

async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout()), ms);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

function jev(): JevFilter | undefined {
	return jevFilterFromConfig(process.env);
}

/** Claude Code permission modes in which an "ask" decision shows the user a prompt. */
const PROMPTING_MODES = new Set(["default", "acceptEdits", "plan"]);

async function claudeHook(): Promise<void> {
	// Claude Code lets the tool proceed when a hook errors (non-2 exit) or times out, so every
	// failure path here emits an explicit deny. Evaluation runs in a worker: a synchronous block
	// there cannot stop this thread's deadline from answering.
	const emit = (decision: "deny" | "ask", reason: string): never => {
		console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
		process.exit(0);
	};
	let input: string;
	let mode: unknown;
	try {
		input = await readStdin();
		mode = (JSON.parse(input) as { permission_mode?: unknown }).permission_mode;
	} catch (error) {
		emit("deny", `[agentic] unreadable hook input, failing closed: ${(error as Error).message}`);
		return;
	}
	const worker = new Worker(new URL("./hook-worker.ts", import.meta.url).href);
	const timer = setTimeout(() => emit("deny", "[agentic] policy check exceeded its deadline; failing closed"), HOOK_DEADLINE_MS);
	worker.onmessage = (event: MessageEvent) => {
		clearTimeout(timer);
		const message = event.data as { ok: boolean; error?: string; result?: { decision: "allow" | "ask" | "deny"; reason: string; policies: string[] } };
		if (!message.ok || !message.result) emit("deny", `[agentic] internal error, failing closed: ${message.error ?? "no result"}`);
		const result = message.result as PipelineResult;
		// Allow emits nothing so Claude's normal permission flow still applies; an explicit
		// "allow" would bypass the user's permission prompts.
		if (result.decision === "allow") process.exit(0);
		const label = `[agentic] ${result.reason}${result.policies.length ? ` (policies: ${result.policies.join(", ")})` : ""}`;
		// Claude approves "ask" silently in modes that never prompt (bypassPermissions and any
		// mode not known to prompt), so those sessions take the pipeline's unattended answer:
		// policy asks and likely hard points are denied, other unreadable commands run.
		if (result.decision === "ask" && mode !== undefined && !PROMPTING_MODES.has(String(mode))) {
			if (result.unattended === "allow") process.exit(0);
			emit("deny", `${label}. This needs the user, and this session cannot ask (permission mode ${String(mode)}): draft the command for the user to run themselves.`);
		}
		emit(result.decision, label);
	};
	worker.onerror = (event: ErrorEvent) => {
		clearTimeout(timer);
		emit("deny", `[agentic] internal error, failing closed: ${event.message}`);
	};
	worker.postMessage(input);
}

const [sub, ...rest] = process.argv.slice(2);
switch (sub) {
	case "check": {
		const call = JSON.parse(await readStdin()) as { toolName: string; input: unknown; cwd?: string };
		const session = sessionFromEnv(process.env, "cli");
		const result = await evaluateToolCall({ toolName: call.toolName, input: call.input, cwd: call.cwd ?? process.cwd() }, { session, env: process.env, jev: jev() });
		recordDecision(process.env, String((call.input as { command?: unknown })?.command ?? ""), result);
		console.log(JSON.stringify(result, null, 2));
		break;
	}
	case "claude-hook":
		await claudeHook();
		break;
	case "explain": {
		if (rest.length === 0) usage(2);
		const command = rest.join(" ");
		const session = sessionFromEnv(process.env, "cli");
		const result = await evaluateToolCall({ toolName: "bash", input: { command }, cwd: process.cwd() }, { session, env: process.env, jev: jev() });
		recordDecision(process.env, command, result);
		console.log(`${result.decision.toUpperCase()}  ${result.reason}`);
		for (const step of result.steps) console.log(`  - ${step.decision.padEnd(5)} ${step.summary}: ${step.reason}`);
		process.exit(result.decision === "deny" ? 1 : 0);
	}
	case "validate": {
		const errors = validateAll(gitContext(process.cwd()).repoRoot);
		for (const error of errors) console.error(error);
		if (errors.length === 0) console.log("policies valid");
		process.exit(errors.length === 0 ? 0 : 1);
	}
	case "status": {
		const ctx = gitContext(process.cwd());
		const origin = ctx.remoteUrl(ctx.cwd, "origin");
		const repo = origin ? repoIdentity(origin) : undefined;
		const grants = readGrants(grantsPath(process.env));
		const grant = grants.find((candidate) => candidate.repo === repo)?.level ?? 0;
		const config = readRepoConfig(ctx.repoRoot);
		const raise = sessionFromEnv(process.env, "cli").sessionRaise;
		const errors = validateAll(ctx.repoRoot);
		const jevConfig = readConfig(process.env).jev;
		const jevState = jevConfig.enabled ? (typesafeKey(process.env) ? `on at P(yes) <= ${jevConfig.threshold}` : "on, but no key (unreadable calls ask)") : "off";
		const status = { repo: repo ?? null, grantsFile: grantsPath(process.env), grant, requestedLevel: config.requestedLevel ?? null, sessionRaise: raise, effectiveLevel: effectiveLevel(grant, config.requestedLevel, raise), posture: config.posture ?? null, policiesValid: errors.length === 0, policyErrors: errors, jev: jevState };
		if (rest.includes("--json")) console.log(JSON.stringify(status, null, 2));
		else console.log(`repo ${status.repo ?? "(no origin)"}: A${status.effectiveLevel} (grant A${grant}, repo request ${status.requestedLevel === null ? "none" : `A${status.requestedLevel}`}, session raise A${raise}), posture ${status.posture ?? "unset"}, policies ${status.policiesValid ? "valid" : "INVALID"}, Jev ${jevState}`);
		process.exit(0);
	}
	case undefined:
		usage(2);
	case "--help":
	case "-h":
		usage(0);
	default: {
		const tool = TOOLS[sub];
		if (!tool) usage(2);
		const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", tool), ...rest], { stdio: ["inherit", "inherit", "inherit"] });
		process.exit(child.exitCode ?? 1);
	}
}
