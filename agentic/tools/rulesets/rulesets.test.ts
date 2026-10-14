import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as rulesets from "./rulesets.ts";
import { desiredRuleset, ruleDiff, settingsDiff, verified } from "./rulesets.ts";

describe("agentic-backstop ruleset", () => {
	test("protects the default branch without bypass and without requiring pull requests or checks", () => {
		const ruleset = desiredRuleset();
		expect(ruleset.bypass_actors).toEqual([]);
		expect(ruleset.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
		expect(ruleset.rules.map((rule) => rule.type)).toEqual(["deletion", "non_fast_forward", "required_linear_history"]);
	});

	test("the merge-gate tier is gone: --tier is a usage error before any GitHub call, and no verdict status is required", () => {
		expect("VERDICT_CONTEXT" in rulesets).toBe(false);
		for (const tier of ["merge-gate", "baseline"]) {
			// PATH holds no gh, so reaching GitHub would fail with exit 1, not 2.
			const run = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "plan", "o/r", "--tier", tier], { encoding: "utf8", env: { PATH: "/nonexistent" } });
			expect(run.status).toBe(2);
			expect(run.stdout).toContain("Usage: rulesets <plan | apply> <owner/repo>\n");
		}
	});

	test("the diff reports added and removed rule types; verification needs every desired type", () => {
		const desired = desiredRuleset().rules;
		expect(ruleDiff([{ type: "deletion" }, { type: "creation" }], desired)).toEqual({ add: ["non_fast_forward", "required_linear_history"], remove: ["creation"] });
		expect(ruleDiff(desired, desired)).toEqual({ add: [], remove: [] });
		// A repository that still carries the retired merge-gate rules plans their removal.
		expect(ruleDiff([...desired, { type: "pull_request", parameters: { required_approving_review_count: 0 } }, { type: "required_status_checks" }], desired)).toEqual({ add: [], remove: ["pull_request", "required_status_checks"] });
		expect(verified([{ type: "deletion" }, { type: "non_fast_forward" }], desired)).toBe(false);
		expect(verified([{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }, { type: "pull_request" }], desired)).toBe(true);
	});

	test("a ruleset that is not enforced, can be bypassed, or targets another branch is not up to date", () => {
		const desired = desiredRuleset();
		expect(settingsDiff(desired, desired)).toEqual([]);
		expect(settingsDiff({ ...desired, conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } } }, desired)).toEqual([]);
		expect(settingsDiff({ ...desired, enforcement: "disabled" }, desired)).toEqual(["enforcement"]);
		expect(settingsDiff({ ...desired, enforcement: "evaluate", bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] }, desired)).toEqual(["enforcement", "bypass_actors"]);
		expect(settingsDiff({ ...desired, conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } } }, desired)).toEqual(["conditions"]);
		expect(settingsDiff({}, desired)).toEqual(["enforcement", "bypass_actors", "conditions"]);
	});
});
