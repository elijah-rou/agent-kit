import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorize, loadPolicySet, validatePolicySet, type Principal } from "../src/engine.ts";
import type { ClassifiedAction, Facts } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const SCHEMA = readFileSync(join(ROOT, "policy/schema.cedarschema"), "utf8");
const GLOBAL = join(ROOT, "policy");

const agent: Principal = { id: "pi-1", isChild: false, harness: "pi" };
const child: Principal = { id: "pi-1/child", isChild: true, harness: "pi" };

function facts(level: number, overrides: Partial<Facts> = {}): Facts {
	return {
		userGrant: level,
		requestedLevel: level,
		sessionRaise: 0,
		effectiveLevel: level,
		force: false,
		verdict: "none",
		verdictSha: "",
		isFrontier: false,
		...overrides,
	};
}

const push = (name: string, force = false, isDefault = false): ClassifiedAction => ({
	action: "git.push",
	resource: { kind: "Branch", name, isDefault, repo: "example/app" },
	force,
	evidence: `git push origin ${name}`,
});
const merge: ClassifiedAction = {
	action: "pr.merge",
	resource: { kind: "PullRequest", number: 7, headSha: "abc123", repo: "example/app" },
	force: false,
	evidence: "gh pr merge 7",
};
const comment = (recipientKind: "person" | "bot" | "unknown"): ClassifiedAction => ({
	action: "comment.post",
	resource: { kind: "Recipient", recipientKind, label: `pr#7/${recipientKind}` },
	force: false,
	evidence: "gh pr comment 7",
});

const set = loadPolicySet(GLOBAL);

describe("global policy set", () => {
	test("loads with no structural errors and validates strictly against the schema", () => {
		expect(set.errors).toEqual([]);
		expect(validatePolicySet(SCHEMA, set.policies)).toEqual([]);
	});

	test("every forbid declares how a match is handled", () => {
		for (const policy of set.policies.filter((p) => p.effect === "forbid")) expect(["deny", "ask"]).toContain(policy.onMatch);
	});
});

describe("autonomy ladder matrix (R8)", () => {
	const cases: [string, ClassifiedAction, Partial<Facts>, Record<number, string>][] = [
		["push agent branch", push("agent/fix"), {}, { 0: "ask", 1: "ask", 2: "allow", 3: "allow", 4: "allow" }],
		["force-push own agent branch", push("agent/fix", true), {}, { 1: "ask", 2: "allow", 4: "allow" }],
		["push default branch", push("main", false, true), {}, { 1: "ask", 2: "ask", 4: "ask" }],
		["force-push shared branch", push("release", true), {}, { 2: "ask", 4: "ask" }],
		["merge with current verdict at frontier", merge, { verdict: "pass", verdictSha: "abc123", isFrontier: true }, { 2: "ask", 3: "ask", 4: "allow" }],
		["merge with stale verdict", merge, { verdict: "pass", verdictSha: "old999", isFrontier: true }, { 4: "ask" }],
		["merge without verdict", merge, {}, { 4: "ask" }],
		["merge verified but not frontier", merge, { verdict: "pass", verdictSha: "abc123", isFrontier: false }, { 4: "ask" }],
		["reply to bot", comment("bot"), {}, { 1: "ask", 2: "allow" }],
		["comment to person", comment("person"), {}, { 1: "deny", 2: "deny", 4: "deny" }],
		["comment to unknown recipient", comment("unknown"), {}, { 2: "deny", 4: "deny" }],
	];
	for (const [name, action, extra, expectations] of cases) {
		for (const [level, expected] of Object.entries(expectations)) {
			test(`${name} at A${level} is ${expected}`, () => {
				const result = authorize(SCHEMA, set.policies, agent, action, facts(Number(level), extra));
				expect(result.errors).toEqual([]);
				expect(result.decision).toBe(expected);
			});
		}
	}
});

describe("hard rules (R4)", () => {
	test("child agents never publish, at any level", () => {
		const result = authorize(SCHEMA, set.policies, child, push("agent/fix"), facts(4));
		expect(result.decision).toBe("deny");
		expect(result.policies).toContain("children-never-publish");
	});

	test("an effective level above the grant is denied even when a permit matches", () => {
		const result = authorize(SCHEMA, set.policies, agent, push("agent/fix"), facts(2, { userGrant: 1 }));
		expect(result.decision).toBe("deny");
		expect(result.policies).toContain("ceiling-never-exceeds-grant");
	});

	test("always-pause actions ask the user", () => {
		for (const action of ["release.publish", "deploy", "credential.change", "data.delete"] as const) {
			const result = authorize(SCHEMA, set.policies, agent, { action, resource: { kind: "Target", targetKind: "x", label: "t" }, force: false, evidence: action }, facts(4));
			expect(result.decision).toBe("ask");
			expect(result.policies).toContain("always-pause-release-deploy-credentials-data");
		}
	});

	test("denials name the policy that decided them", () => {
		const result = authorize(SCHEMA, set.policies, agent, comment("person"), facts(2));
		expect(result.reason).toContain("messages-to-people-go-through-user");
	});
});

function tempRepoPolicyDir(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-policy-"));
	mkdirSync(join(dir, "policy"));
	writeFileSync(join(dir, "policy", "repo.cedar"), text);
	return join(dir, "policy");
}

describe("repo policy files (R2)", () => {
	test("a repo forbid tightens the global set", () => {
		const repoDir = tempRepoPolicyDir(`@id("repo-no-merges")\n@effect("ask")\nforbid (principal, action == Action::"pr.merge", resource);\n`);
		const loaded = loadPolicySet(GLOBAL, repoDir);
		expect(loaded.errors).toEqual([]);
		const result = authorize(SCHEMA, loaded.policies, agent, merge, facts(4, { verdict: "pass", verdictSha: "abc123", isFrontier: true }));
		expect(result.decision).toBe("ask");
		expect(result.policies).toContain("repo-no-merges");
	});

	test("a repo permit fails validation and is not loaded", () => {
		const repoDir = tempRepoPolicyDir(`@id("repo-broaden")\npermit (principal, action == Action::"git.push", resource);\n`);
		const loaded = loadPolicySet(GLOBAL, repoDir);
		expect(loaded.errors.join("\n")).toContain("repo policies may only forbid");
		expect(loaded.policies.map((p) => p.id)).not.toContain("repo-broaden");
	});

	test("a forbid without @effect is rejected", () => {
		const repoDir = tempRepoPolicyDir(`@id("repo-unclear")\nforbid (principal, action == Action::"pr.merge", resource);\n`);
		expect(loadPolicySet(GLOBAL, repoDir).errors.join("\n")).toContain("needs @effect");
	});
});

describe("schema validation (R3)", () => {
	test("a typo'd attribute is a validation error, not a silent permit", () => {
		const repoDir = tempRepoPolicyDir(`@id("repo-typo")\n@effect("deny")\nforbid (principal, action == Action::"git.push", resource is Branch) when { resource.nmae == "main" };\n`);
		const loaded = loadPolicySet(GLOBAL, repoDir);
		expect(loaded.errors).toEqual([]);
		const errors = validatePolicySet(SCHEMA, loaded.policies);
		expect(errors.join("\n")).toContain("repo-typo");
	});
});
