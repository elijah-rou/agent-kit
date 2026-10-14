// Server-side backstop for agents: one GitHub ruleset, "agentic-backstop", on a
// repository's default branch: it cannot be deleted or force-pushed, and its history stays linear.
// No friction for direct pushes; apply it to every repository. Agents use the user's token (no
// agent identity, design O4), so the ruleset has no bypass actors: anything the user could bypass,
// an agent could too. It guarantees mechanical properties, not that a human approved a change. The
// merge gate is local: merging modes check the verdict ledger with `agentic verify status`.

export const RULESET_NAME = "agentic-backstop";

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

/** The desired ruleset. */
export function desiredRuleset(): Ruleset {
	return {
		name: RULESET_NAME,
		target: "branch",
		enforcement: "active",
		conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
		bypass_actors: [],
		rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }],
	};
}

/** Rule types the existing ruleset lacks or has beyond the desired one. The desired rules take no parameters. */
export function ruleDiff(current: readonly Rule[], desired: readonly Rule[]): { add: string[]; remove: string[] } {
	const now = new Set(current.map((rule) => rule.type));
	const want = new Set(desired.map((rule) => rule.type));
	return { add: [...want].filter((type) => !now.has(type)), remove: [...now].filter((type) => !want.has(type)) };
}

/**
 * Ruleset-level settings that differ from the desired ruleset. Matching rules guarantee nothing if
 * the ruleset is disabled or in evaluate mode, has a bypass actor, or targets another branch.
 */
export function settingsDiff(current: { enforcement?: string; bypass_actors?: unknown[]; conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } }, desired: Ruleset): string[] {
	const refs = (list: readonly string[] | undefined) => JSON.stringify([...(list ?? [])].sort());
	const ref = current.conditions?.ref_name;
	const differs = {
		enforcement: current.enforcement !== desired.enforcement,
		bypass_actors: JSON.stringify(current.bypass_actors ?? null) !== JSON.stringify(desired.bypass_actors),
		conditions: !ref || refs(ref.include) !== refs(desired.conditions.ref_name.include) || refs(ref.exclude) !== refs(desired.conditions.ref_name.exclude),
	};
	return Object.entries(differs).filter(([, changed]) => changed).map(([setting]) => setting);
}

/** True when the active rules on the default branch include every desired rule type. */
export function verified(active: readonly { type: string }[], desired: readonly Rule[]): boolean {
	const types = new Set(active.map((rule) => rule.type));
	return desired.every((rule) => types.has(rule.type));
}
