// Server-side backstop for the local policy gate: one GitHub ruleset, "agentic-backstop", on a
// repository's default branch. Agents use the user's token (no agent identity, design O4), so the
// ruleset has no bypass actors: anything the user could bypass, an agent could too. It guarantees
// mechanical properties, not that a human approved a change.
//
// Tiers:
// - baseline: the default branch cannot be deleted or force-pushed, and its history stays linear.
//   No friction for direct pushes; apply it to every repository.
// - merge-gate: baseline plus a pull request, the agentic/verdict check from a fresh verifier, and
//   the repository's passing CI checks before the default branch moves. Everyone, the user
//   included, then lands through pull requests; apply it when a repository moves to verified
//   stacks (autonomy A3 and above).

export const RULESET_NAME = "agentic-backstop";

/** The status `agentic verify record` posts; merge-gate requires it. */
export const VERDICT_CONTEXT = "agentic/verdict";

export type Tier = "baseline" | "merge-gate";

export interface Rule {
	type: string;
	parameters?: Record<string, unknown>;
}

export interface Ruleset {
	name: string;
	target: "branch";
	enforcement: "active";
	conditions: { ref_name: { include: string[]; exclude: string[] } };
	bypass_actors: never[];
	rules: Rule[];
}

/** The desired ruleset. Checks are CI status contexts that must pass besides the verdict (merge-gate only). */
export function desiredRuleset(tier: Tier, checks: readonly string[]): Ruleset {
	const rules: Rule[] = [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }];
	if (tier === "merge-gate") {
		rules.push({
			type: "pull_request",
			parameters: {
				required_approving_review_count: 0,
				dismiss_stale_reviews_on_push: false,
				require_code_owner_review: false,
				require_last_push_approval: false,
				required_review_thread_resolution: false,
			},
		});
		rules.push({
			type: "required_status_checks",
			parameters: { strict_required_status_checks_policy: false, required_status_checks: [...new Set([VERDICT_CONTEXT, ...checks])].sort().map((context) => ({ context })) },
		});
	}
	return {
		name: RULESET_NAME,
		target: "branch",
		enforcement: "active",
		conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
		bypass_actors: [],
		rules,
	};
}

/** Check runs on the default branch head: those that passed can be required; the rest are reported. */
export function splitChecks(runs: readonly { name: string; conclusion: string | null }[]): { passing: string[]; other: string[] } {
	const passing = new Set<string>();
	const other = new Set<string>();
	for (const run of runs) (run.conclusion === "success" ? passing : other).add(run.name);
	for (const name of passing) other.delete(name);
	return { passing: [...passing].sort(), other: [...other].sort() };
}

/** Rule types in the existing ruleset that differ from the desired one, as added and removed lists. */
export function ruleDiff(current: readonly Rule[], desired: readonly Rule[]): { add: string[]; remove: string[]; change: string[] } {
	const key = (rule: Rule) => JSON.stringify(rule.parameters ?? {});
	const now = new Map(current.map((rule) => [rule.type, key(rule)]));
	const want = new Map(desired.map((rule) => [rule.type, key(rule)]));
	return {
		add: [...want.keys()].filter((type) => !now.has(type)),
		remove: [...now.keys()].filter((type) => !want.has(type)),
		change: [...want.keys()].filter((type) => now.has(type) && now.get(type) !== want.get(type)),
	};
}

/** True when the active rules on the default branch include every desired rule type. */
export function verified(active: readonly { type: string }[], desired: readonly Rule[]): boolean {
	const types = new Set(active.map((rule) => rule.type));
	return desired.every((rule) => types.has(rule.type));
}
