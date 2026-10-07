import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	TableError,
	checkTable,
	collectCedarIds,
	findDuplicates,
	parseTable,
	restatementScore,
	stripCedarComments,
} from "./rule-table.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const CLI = join(import.meta.dir, "cli.ts");

function check(name: string): string[] {
	const root = join(FIXTURES, name);
	const table = parseTable(readFileSync(join(root, "rules.toml"), "utf8"));
	return checkTable(table, root).map((e) => `${e.line} [${e.rule}] ${e.message}`);
}

describe("check", () => {
	it("accepts the good table, resolving Cedar ids in policy/ and .agents/policy/", () => {
		expect(check("good")).toEqual([]);
		expect(collectCedarIds(join(FIXTURES, "good"))).toEqual(
			new Set(["pause-default-branch", "messages-go-through-user", "no-force-push"]),
		);
	});

	it("reports every problem in the bad table", () => {
		expect(check("bad")).toEqual([
			"8 [dup] duplicate id; first defined at line 1",
			'8 [dup] no @id("commented-out") in policy/*.cedar or .agents/policy/*.cedar',
			'15 [missing-files] enforcer.ref "hooks/nope.ts" does not exist',
			'15 [missing-files] proof.test "tests/nope-proof.ts" does not exist',
			"22 [no-past-mistake] proof.past_mistake must name the real past mistake this check catches",
			'29 [judgment-missing] level "instruction" requires judgment = true',
			'29 [judgment-missing] level "instruction" requires a non-empty judgment_reason',
			'36 [judgment-misplaced] judgment and judgment_reason are only allowed on level "instruction"',
			'45 [schema-errors] unknown key "severity"',
			"45 [schema-errors] statement must be a non-empty string",
			"45 [schema-errors] level must be one of architecture, types, lint, test, hook, cedar, instruction",
			'45 [schema-errors] unknown key "proof.pastmistake"',
			"45 [schema-errors] enforcer.ref must be a non-empty string",
		]);
	});

	it("ignores annotations inside comments but keeps // inside strings", () => {
		const source = '// @id("gone")\n@id("kept") @note("a//b")\n';
		expect(stripCedarComments(source)).toBe('\n@id("kept") @note("a//b")\n');
	});

	it("raises a parse error for malformed TOML", () => {
		expect(() => parseTable("[[rule]]\nid = ")).toThrow(TableError);
	});
});

describe("duplicates", () => {
	const root = join(FIXTURES, "good");
	const table = parseTable(readFileSync(join(root, "rules.toml"), "utf8"));
	const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");

	it("flags verbatim and paraphrased restatements of enforced rules only", () => {
		const found = findDuplicates(table.rules, "AGENTS.md", instructions, 0.8);
		expect(found.map((d) => `${d.line} ${d.rule} ${d.score}`)).toEqual([
			"4 no-push-to-main 1",
			"5 no-push-to-main 1",
		]);
	});

	it("scores by substring first, then by content-token overlap", () => {
		expect(restatementScore("Use named exports only.", "- use named exports only!")).toBe(1);
		expect(restatementScore("Use named exports only.", "Prefer named exports.")).toBe(0.5);
		expect(restatementScore("Be terse.", "be terse and clear")).toBe(1);
		expect(restatementScore("Be terse.", "terse")).toBe(0);
	});

	it("respects a stricter threshold", () => {
		const loose = findDuplicates(table.rules, "x", "Use named exports.", 0.7);
		expect(loose.map((d) => d.rule)).toEqual(["named-exports"]);
		expect(findDuplicates(table.rules, "x", "Use named exports.", 0.8)).toEqual([]);
	});
});

describe("cli", () => {
	function run(...args: string[]) {
		return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
	}

	it("prints usage on --help and exits non-zero on invalid input", () => {
		const help = run("--help");
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage: rule-table");
		expect(run().status).toBe(2);
		expect(run("frobnicate").status).toBe(2);
		expect(run("check").status).toBe(2);
		expect(run("check", join(FIXTURES, "nope.toml")).status).toBe(2);
		expect(run("duplicates", "--threshold", "2", "x.md").status).toBe(2);
	});

	it("exits by result", () => {
		expect(run("check", join(FIXTURES, "good", "rules.toml")).status).toBe(0);
		const bad = run("check", join(FIXTURES, "bad", "rules.toml"));
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("bad/rules.toml:8: [dup] duplicate id");
		const rules = join(FIXTURES, "good", "rules.toml");
		const duplicates = run("duplicates", "--rules", rules, join(FIXTURES, "good", "AGENTS.md"));
		expect(duplicates.status).toBe(1);
		expect(duplicates.stdout).toContain("AGENTS.md:4: restates rule no-push-to-main");
	});
});
