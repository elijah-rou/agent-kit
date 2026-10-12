import { describe, expect, test } from "bun:test";
import { desiredRuleset, ruleDiff, settingsDiff, splitChecks, verified } from "./rulesets.ts";

describe("agentic-backstop ruleset", () => {
	test("baseline protects the default branch without bypass and without requiring pull requests", () => {
		const ruleset = desiredRuleset("baseline", []);
		expect(ruleset.bypass_actors).toEqual([]);
		expect(ruleset.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
		expect(ruleset.rules.map((rule) => rule.type)).toEqual(["deletion", "non_fast_forward", "required_linear_history"]);
	});

	test("merge-gate adds a pull request, the verdict check, and the passing CI checks", () => {
		const types = desiredRuleset("merge-gate", ["validate (macos-latest)", "validate (ubuntu-latest)", "validate (macos-latest)"]).rules;
		expect(types.map((rule) => rule.type)).toEqual(["deletion", "non_fast_forward", "required_linear_history", "pull_request", "required_status_checks"]);
		expect(types[4].parameters?.required_status_checks).toEqual([{ context: "agentic/verdict" }, { context: "validate (macos-latest)" }, { context: "validate (ubuntu-latest)" }]);
		expect(desiredRuleset("merge-gate", []).rules[4].parameters?.required_status_checks).toEqual([{ context: "agentic/verdict" }]);
	});

	test("only checks that passed on the head are required", () => {
		expect(splitChecks([{ name: "linux", conclusion: "failure" }, { name: "macos", conclusion: "success" }, { name: "lint", conclusion: null }])).toEqual({ passing: ["macos"], other: ["lint", "linux"] });
	});

	test("the diff reports added, changed, and removed rule types; verification needs every desired type", () => {
		const desired = desiredRuleset("baseline", []).rules;
		expect(ruleDiff([{ type: "deletion" }, { type: "creation" }], desired)).toEqual({ add: ["non_fast_forward", "required_linear_history"], remove: ["creation"], change: [] });
		expect(ruleDiff(desired, desired)).toEqual({ add: [], remove: [], change: [] });
		expect(verified([{ type: "deletion" }, { type: "non_fast_forward" }], desired)).toBe(false);
		expect(verified([{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }, { type: "pull_request" }], desired)).toBe(true);
	});

	test("parameters GitHub adds to a stored rule do not count as a change", () => {
		const desired = desiredRuleset("merge-gate", ["validate (macos-latest)", "validate (ubuntu-latest)"]).rules;
		// The merge-gate rules as GitHub returned them after apply, with its server-side defaults.
		const stored = [
			{ type: "deletion" },
			{ type: "non_fast_forward" },
			{ type: "required_linear_history" },
			{
				type: "pull_request",
				parameters: {
					allowed_merge_methods: ["merge", "squash", "rebase"],
					dismiss_stale_reviews_on_push: false,
					require_code_owner_review: false,
					require_extra_approval_for_unattributed_changes: true,
					require_last_push_approval: false,
					required_approving_review_count: 0,
					required_review_thread_resolution: false,
					required_reviewers: [],
				},
			},
			{
				type: "required_status_checks",
				parameters: {
					do_not_enforce_on_create: false,
					required_status_checks: [{ context: "agentic/verdict" }, { context: "validate (macos-latest)" }, { context: "validate (ubuntu-latest)" }],
					strict_required_status_checks_policy: false,
				},
			},
		];
		expect(ruleDiff(stored, desired)).toEqual({ add: [], remove: [], change: [] });
		const withoutVerdict = stored.map((rule) => (rule.type === "required_status_checks" ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [{ context: "validate (macos-latest)" }] } } : rule));
		expect(ruleDiff(withoutVerdict, desired).change).toEqual(["required_status_checks"]);
		const needsApproval = stored.map((rule) => (rule.type === "pull_request" ? { ...rule, parameters: { ...rule.parameters, required_approving_review_count: 1 } } : rule));
		expect(ruleDiff(needsApproval, desired).change).toEqual(["pull_request"]);
		const missingParameter = stored.map((rule) => (rule.type === "pull_request" ? { type: "pull_request" } : rule));
		expect(ruleDiff(missingParameter, desired).change).toEqual(["pull_request"]);
		const checks = (list: string[], extra: Record<string, unknown> = {}) => stored.map((rule) => (rule.type === "required_status_checks" ? { ...rule, parameters: { ...rule.parameters, ...extra, required_status_checks: list.map((context) => ({ context })) } } : rule));
		expect(ruleDiff(checks(["validate (ubuntu-latest)", "validate (macos-latest)", "agentic/verdict"]), desired).change).toEqual([]);
		expect(ruleDiff(checks(["agentic/verdict", "validate (macos-latest)", "validate (ubuntu-latest)", "lint"]), desired).change).toEqual(["required_status_checks"]);
		expect(ruleDiff(checks(["agentic/verdict", "validate (macos-latest)", "validate (ubuntu-latest)"], { do_not_enforce_on_create: true }), desired).change).toEqual(["required_status_checks"]);
	});

	test("a ruleset that is not enforced, can be bypassed, or targets another branch is not up to date", () => {
		const desired = desiredRuleset("baseline", []);
		expect(settingsDiff(desired, desired)).toEqual([]);
		expect(settingsDiff({ ...desired, conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } } }, desired)).toEqual([]);
		expect(settingsDiff({ ...desired, enforcement: "disabled" }, desired)).toEqual(["enforcement"]);
		expect(settingsDiff({ ...desired, enforcement: "evaluate", bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] }, desired)).toEqual(["enforcement", "bypass_actors"]);
		expect(settingsDiff({ ...desired, conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } } }, desired)).toEqual(["conditions"]);
		expect(settingsDiff({}, desired)).toEqual(["enforcement", "bypass_actors", "conditions"]);
	});
});
