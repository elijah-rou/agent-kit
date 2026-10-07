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
