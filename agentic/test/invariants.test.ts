// Exhaustive policy invariants: the decisions the design guarantees, checked for every
// combination of facts the policies can tell apart. The policies compare attributes only by
// equality, `like` on branch names, and membership in small string sets, so one representative per
// equivalence class (default branch, agent/* branch, any other branch; each recipient and protected
// kind; matching or stale verdict SHA) covers every behavior. This stands in for symbolic analysis
// (cedar-policy-symcc), which needs an SMT solver this repository does not carry.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorize, loadPolicySet, type Principal } from "../src/engine.ts";
import type { ClassifiedAction, Decision, Facts } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const SCHEMA = readFileSync(join(ROOT, "policy/schema.cedarschema"), "utf8");
const GLOBAL = loadPolicySet(join(ROOT, "policy")).policies;

const HEAD = "abc123";
const REPO = "github.com/example/app";
const branch = (name: string, isDefault = false) => ({ kind: "Branch" as const, name, isDefault, repo: REPO });
const BRANCHES = [branch("main", true), branch("agent/topic"), branch("feature")];
const PR = { kind: "PullRequest" as const, number: 7, headSha: HEAD, repo: REPO };
const PROTECTED = ["grants", "user-config", "global-policy", "ledger", "decision-log", "forge", "enforcement", "repo-policy", "learned"];

function actions(): ClassifiedAction[] {
	const out: ClassifiedAction[] = [];
	const add = (action: ClassifiedAction["action"], resource: ClassifiedAction["resource"], force = false) => out.push({ action, resource, force, evidence: action });
	for (const b of BRANCHES) for (const force of [false, true]) add("git.push", b, force);
	for (const b of BRANCHES) add("git.delete_remote_branch", b);
	add("pr.create", { kind: "Repo", origin: REPO });
	add("pr.merge", PR);
	for (const recipientKind of ["person", "bot", "unknown"] as const) add("comment.post", { kind: "Recipient", recipientKind, label: `${REPO}:pr#7` });
	for (const action of ["release.publish", "deploy", "credential.change", "data.delete"] as const) add(action, { kind: "Target", targetKind: "x", label: "x" });
	for (const protectedKind of PROTECTED) add("file.write", { kind: "ProtectedPath", protectedKind, path: `/p/${protectedKind}` });
	add("verdict.record", PR);
	add("verdict.forge", PR);
	for (const action of ["git.skip_hooks", "git.integrate", "git.interactive"] as const) add(action, { kind: "Repo", origin: REPO });
	return out;
}

/** Verdict, frontier, and authorship facts are read only for pull requests, so only those vary them. */
function* factSpace(forPullRequest: boolean): Generator<Facts> {
	for (let grant = 0; grant <= 4; grant++) {
		// Effective levels up to the grant, plus one above it, which the ceiling policy must refuse.
		for (let level = 0; level <= Math.min(4, grant + 1); level++) {
			const base = { userGrant: grant, requestedLevel: level, sessionRaise: 0, effectiveLevel: level, force: false };
			if (!forPullRequest) {
				yield { ...base, verdict: "none", verdictSha: "", isFrontier: false, isAuthor: false };
				continue;
			}
			for (const verdict of ["none", "pass", "verifier-failed"]) {
				for (const verdictSha of [HEAD, "stale"]) {
					for (const isFrontier of [false, true]) {
						for (const isAuthor of [false, true]) yield { ...base, verdict, verdictSha, isFrontier, isAuthor };
					}
				}
			}
		}
	}
}

type Case = { action: ClassifiedAction; facts: Facts; child: boolean; decision: Decision };

function decide(policies = GLOBAL): Case[] {
	const cases: Case[] = [];
	for (const action of actions()) {
		for (const facts of factSpace(action.resource.kind === "PullRequest")) {
			for (const child of [false, true]) {
				const principal: Principal = { id: child ? "agent/child" : "agent", isChild: child, harness: "test" };
				const result = authorize(SCHEMA, policies, principal, action, { ...facts, force: action.force });
				expect(result.errors).toEqual([]);
				cases.push({ action, facts, child, decision: result.decision });
			}
		}
	}
	return cases;
}

const cases = decide();
const allowed = (predicate: (c: Case) => boolean) => cases.filter((c) => c.decision === "allow" && predicate(c)).map((c) => `${c.action.action} ${JSON.stringify(c.action.resource)} child=${c.child} ${JSON.stringify(c.facts)}`);
const isBranch = (c: Case, name: string) => c.action.resource.kind === "Branch" && c.action.resource.name === name;

describe("policy invariants over every distinguishable fact combination", () => {
	test("the space is covered", () => {
		expect(cases.length).toBe(3838);
	});

	test("nothing is allowed above the user's grant", () => {
		expect(allowed((c) => c.facts.effectiveLevel > c.facts.userGrant)).toEqual([]);
	});

	test("children never publish, integrate, or record verdicts they could have authored", () => {
		expect(allowed((c) => c.child && ["git.push", "git.delete_remote_branch", "pr.create", "pr.merge", "comment.post", "git.integrate"].includes(c.action.action))).toEqual([]);
	});

	test("the default branch is never pushed or deleted, and shared branches are never force-pushed or deleted", () => {
		expect(allowed((c) => isBranch(c, "main") && ["git.push", "git.delete_remote_branch"].includes(c.action.action))).toEqual([]);
		expect(allowed((c) => isBranch(c, "feature") && (c.action.force || c.action.action === "git.delete_remote_branch"))).toEqual([]);
	});

	test("a merge needs A4, a passing verdict on the current head, and the frontier", () => {
		expect(allowed((c) => c.action.action === "pr.merge" && !(c.facts.effectiveLevel === 4 && c.facts.verdict === "pass" && c.facts.verdictSha === HEAD && c.facts.isFrontier))).toEqual([]);
	});

	test("messages to people, releases, deploys, credentials, and data deletion are never allowed", () => {
		expect(allowed((c) => c.action.resource.kind === "Recipient" && c.action.resource.recipientKind !== "bot")).toEqual([]);
		expect(allowed((c) => ["release.publish", "deploy", "credential.change", "data.delete"].includes(c.action.action))).toEqual([]);
	});

	test("agents never write a protected path, and the blocked kinds are denied, not asked", () => {
		expect(allowed((c) => c.action.action === "file.write")).toEqual([]);
		const blocked = ["grants", "user-config", "global-policy", "ledger", "decision-log", "forge"];
		expect(cases.filter((c) => c.action.resource.kind === "ProtectedPath" && blocked.includes(c.action.resource.protectedKind) && c.decision !== "deny")).toEqual([]);
	});

	test("an author never records its own verdict, and the verdict status is never posted directly", () => {
		expect(allowed((c) => c.action.action === "verdict.record" && c.facts.isAuthor)).toEqual([]);
		expect(allowed((c) => c.action.action === "verdict.forge")).toEqual([]);
	});

	test("hooks are never skipped and editors never opened", () => {
		expect(allowed((c) => ["git.skip_hooks", "git.interactive"].includes(c.action.action))).toEqual([]);
	});

	test("a repository's forbid-only policies can only tighten a decision", () => {
		const rank: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
		const repo: typeof GLOBAL = [
			{ id: "repo-no-pushes", text: '@id("repo-no-pushes")\n@effect("ask")\nforbid (principal, action == Action::"git.push", resource);', effect: "forbid", onMatch: "ask", source: "test", scope: "repo" },
			{ id: "repo-no-bots", text: '@id("repo-no-bots")\n@effect("deny")\nforbid (principal, action == Action::"comment.post", resource);', effect: "forbid", onMatch: "deny", source: "test", scope: "repo" },
		];
		const tightened = decide([...GLOBAL, ...repo]);
		expect(tightened.filter((c) => c.action.action === "git.push" && c.decision === "allow")).toEqual([]);
		const loosened = tightened.filter((c, i) => rank[c.decision] < rank[cases[i].decision]);
		expect(loosened).toEqual([]);
	}, 60_000);
});
