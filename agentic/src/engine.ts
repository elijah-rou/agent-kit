import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ClassifiedAction, Decision, Facts, PolicyDecision, Resource } from "./types.ts";

export type PolicyEffectAnnotation = "deny" | "ask";

export interface LoadedPolicy {
	id: string;
	text: string;
	effect: "permit" | "forbid";
	/** For forbid policies: whether a match blocks outright or asks the user. */
	onMatch?: PolicyEffectAnnotation;
	source: string;
	scope: "global" | "repo";
}

export interface PolicySetLoad {
	policies: LoadedPolicy[];
	errors: string[];
}

function cedarFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".cedar"))
		.sort()
		.map((name) => join(dir, name));
}

function messages(errors: { message: string }[]): string {
	return errors.map((error) => error.message).join("; ");
}

/**
 * Parses every .cedar file in the given directories into named policies and checks the
 * structural rules the design adds on top of Cedar: every policy has @id, every forbid has
 * @effect("deny"|"ask"), IDs are unique, and repo files contain only forbid statements so a
 * repository can tighten but never broaden what the global policies permit.
 */
export function loadPolicySet(globalDir: string, repoDir?: string): PolicySetLoad {
	const policies: LoadedPolicy[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	const sources: [string, "global" | "repo"][] = [
		...cedarFiles(globalDir).map((file) => [file, "global"] as [string, "global"]),
		...(repoDir ? cedarFiles(repoDir).map((file) => [file, "repo"] as [string, "repo"]) : []),
	];
	for (const [file, scope] of sources) {
		const parts = cedar.policySetTextToParts(readFileSync(file, "utf8"));
		if (parts.type === "failure") {
			errors.push(`${file}: ${messages(parts.errors)}`);
			continue;
		}
		if (parts.policy_templates.length > 0) errors.push(`${file}: templates are not supported`);
		for (const text of parts.policies) {
			const parsed = cedar.policyToJson(text);
			if (parsed.type === "failure") {
				errors.push(`${file}: ${messages(parsed.errors)}`);
				continue;
			}
			const annotations = parsed.json.annotations ?? {};
			const id = annotations.id;
			if (!id) {
				errors.push(`${file}: a policy is missing @id`);
				continue;
			}
			if (seen.has(id)) errors.push(`${file}: duplicate policy id ${id}`);
			seen.add(id);
			const effect = parsed.json.effect;
			if (scope === "repo" && effect !== "forbid") {
				errors.push(`${file}: repo policy ${id} is a permit; repo policies may only forbid`);
				continue;
			}
			let onMatch: PolicyEffectAnnotation | undefined;
			if (effect === "forbid") {
				const declared = annotations.effect;
				if (declared !== "deny" && declared !== "ask") {
					errors.push(`${file}: forbid ${id} needs @effect("deny") or @effect("ask")`);
					continue;
				}
				onMatch = declared;
			}
			policies.push({ id, text, effect, onMatch, source: file, scope });
		}
	}
	return { policies, errors };
}

export function validatePolicySet(schema: string, policies: LoadedPolicy[]): string[] {
	const result = cedar.validate({
		schema,
		policies: { staticPolicies: Object.fromEntries(policies.map((policy) => [policy.id, policy.text])) },
		validationSettings: { mode: "strict" },
	});
	if (result.type === "failure") return result.errors.map((error) => error.message);
	return result.validationErrors.map((error) => `${error.policyId}: ${error.error.message}`);
}

const REPO = "Repo";

function entityFor(resource: Resource): { uid: { type: string; id: string }; attrs: Record<string, unknown>; parents: { type: string; id: string }[] } {
	switch (resource.kind) {
		case "Branch":
			return {
				uid: { type: "Branch", id: `${resource.repo}#${resource.name}` },
				attrs: { name: resource.name, isDefault: resource.isDefault },
				parents: [{ type: REPO, id: resource.repo }],
			};
		case "Repo":
			return { uid: { type: REPO, id: resource.origin }, attrs: { origin: resource.origin }, parents: [] };
		case "PullRequest":
			return {
				uid: { type: "PullRequest", id: `${resource.repo}#${resource.number}` },
				attrs: { number: resource.number, headSha: resource.headSha },
				parents: [{ type: REPO, id: resource.repo }],
			};
		case "Recipient":
			return { uid: { type: "Recipient", id: resource.label }, attrs: { kind: resource.recipientKind }, parents: [] };
		case "Target":
			return { uid: { type: "Target", id: resource.label }, attrs: { kind: resource.targetKind }, parents: [] };
		case "ProtectedPath":
			return { uid: { type: "ProtectedPath", id: resource.path }, attrs: { kind: resource.protectedKind, path: resource.path }, parents: [] };
	}
}

function repoOf(resource: Resource): string | undefined {
	if (resource.kind === "Branch" || resource.kind === "PullRequest") return resource.repo;
	if (resource.kind === "Repo") return resource.origin;
	return undefined;
}

export interface Principal {
	id: string;
	isChild: boolean;
	harness: string;
}

/**
 * Evaluates one classified action. Cedar decides allow or deny; the forbid policies that
 * determined a denial carry @effect, which maps the denial to "deny" or "ask". A denial with no
 * determining forbid means nothing permits the action at this level, which asks the user.
 * Evaluation errors fail closed to "deny".
 */
export function authorize(
	schema: string,
	policies: LoadedPolicy[],
	principal: Principal,
	classified: ClassifiedAction,
	facts: Facts,
): PolicyDecision {
	const resourceEntity = entityFor(classified.resource);
	const repo = repoOf(classified.resource);
	const entities = [
		{ uid: { type: "Agent", id: principal.id }, attrs: { isChild: principal.isChild, harness: principal.harness }, parents: [] },
		resourceEntity,
		...(repo && classified.resource.kind !== "Repo" ? [{ uid: { type: REPO, id: repo }, attrs: { origin: repo }, parents: [] }] : []),
	];
	const answer = cedar.isAuthorized({
		principal: { type: "Agent", id: principal.id },
		action: { type: "Action", id: classified.action },
		resource: resourceEntity.uid,
		context: { ...facts, force: classified.force },
		schema,
		validateRequest: true,
		policies: { staticPolicies: Object.fromEntries(policies.map((policy) => [policy.id, policy.text])) },
		entities: entities as never,
	});
	if (answer.type === "failure") {
		const errors = answer.errors.map((error) => error.message);
		return { decision: "deny", policies: [], reason: `policy evaluation failed: ${errors.join("; ")}`, errors };
	}
	const determining = answer.response.diagnostics.reason;
	const errors = answer.response.diagnostics.errors.map((error) => `${error.policyId}: ${error.error.message}`);
	if (errors.length > 0) {
		return { decision: "deny", policies: determining, reason: "a policy errored during evaluation; failing closed", errors };
	}
	if (answer.response.decision === "allow") {
		return { decision: "allow", policies: determining, reason: `permitted by ${determining.join(", ")}`, errors };
	}
	const byId = new Map(policies.map((policy) => [policy.id, policy]));
	const forbids = determining.map((id) => byId.get(id)).filter((policy): policy is LoadedPolicy => policy !== undefined);
	if (forbids.length === 0) {
		return {
			decision: "ask",
			policies: [],
			reason: `no policy permits ${classified.action} at autonomy level ${facts.effectiveLevel}`,
			errors,
		};
	}
	const decision: Decision = forbids.some((policy) => policy.onMatch === "deny") ? "deny" : "ask";
	return { decision, policies: forbids.map((policy) => policy.id), reason: `${decision === "deny" ? "blocked" : "needs the user"}: ${forbids.map((policy) => policy.id).join(", ")}`, errors };
}
