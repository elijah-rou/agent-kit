import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintReport } from "./report-lint.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const CLI = join(import.meta.dir, "cli.ts");

function lint(name: string): string[] {
	const text = readFileSync(join(FIXTURES, name), "utf8");
	return lintReport(text).map((error) => `${error.line}: ${error.message}`);
}

describe("report-lint", () => {
	it.each(["good-nothing.md", "good-questions.md", "good-bold-lead.md"])(
		"accepts %s",
		(name) => {
			expect(lint(name)).toEqual([]);
		},
	);

	it("rejects a report whose first section is not Needs you", () => {
		expect(lint("bad-order.md")).toEqual([
			'3: first section must be "Needs you" (write "Needs you: nothing" if none)',
		]);
	});

	it("rejects an empty Needs you section", () => {
		expect(lint("bad-empty.md")).toEqual([
			'3: Needs you part is empty; write "Needs you: nothing" if none',
		]);
	});

	it("rejects questions without options, a recommendation and a default", () => {
		expect(lint("bad-questions.md")).toEqual([
			"3: question lacks Recommend, Default after it",
			"5: question lacks Options, Recommend, Default after it",
			"11: question lacks Options, Recommend, Default after it",
		]);
	});

	it("accepts the plain and bold explicit nothing forms", () => {
		expect(lintReport("Needs you: nothing\n\n## Outcome\n\nDone.\n")).toEqual([]);
		expect(lintReport("**Needs you:** nothing\n")).toEqual([]);
		expect(lintReport("# Title\n\n## Needs you\n\nNothing.\n")).toEqual([]);
	});

	it("rejects an empty report and a bare lead", () => {
		expect(lintReport("\n\n")).toHaveLength(1);
		expect(lintReport("**Needs you:**\n\n## Outcome\n\nDone.\n")).toEqual([
			{ line: 1, message: 'Needs you part is empty; write "Needs you: nothing" if none' },
		]);
	});

	// These pin the documented limits so a change in behavior is a deliberate one.
	describe("heuristic limits", () => {
		it("misses a question that does not end its line", () => {
			expect(lintReport("## Needs you\n\n- Merge now? I can wait.\n")).toEqual([]);
		});

		it("does not check questions outside Needs you", () => {
			const text = "Needs you: nothing\n\n## Outcome\n\nShould I merge?\n";
			expect(lintReport(text)).toEqual([]);
		});

		it("counts marker words anywhere after the question in the item", () => {
			const text = "## Needs you\n\n- Ship?\n  Options and recommend aside, the default config.\n";
			expect(lintReport(text)).toEqual([]);
		});

		it("ignores markers that come before the question", () => {
			const text = "## Needs you\n\n- Options: a, b. Recommend a. Default a.\n  Which one?\n";
			expect(lintReport(text)).toHaveLength(1);
		});
	});
});

describe("cli", () => {
	function run(args: string[], input?: string) {
		return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input });
	}

	it("prints usage on --help and exits non-zero on invalid input", () => {
		const help = run(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage: report-lint");
		expect(run([]).status).toBe(2);
		expect(run(["--bogus"]).status).toBe(2);
		expect(run([join(FIXTURES, "nope.md")]).status).toBe(2);
		const bad = run([join(FIXTURES, "bad-order.md")]);
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("bad-order.md:3: first section");
	});

	it("reads stdin", () => {
		expect(run(["-"], "Needs you: nothing\n").status).toBe(0);
		expect(run(["-"], "## Outcome\n\nDone.\n").stderr).toContain("<stdin>:1:");
	});
});
