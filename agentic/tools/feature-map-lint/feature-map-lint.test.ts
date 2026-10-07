import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFeature, lintFeatureMap, parseDocument } from "./feature-map-lint.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const CLI = join(import.meta.dir, "cli.ts");

function render(directory: string): string[] {
	return lintFeatureMap(directory).map((e) => `${e.file}:${e.line}: ${e.message}`);
}

describe("feature-map-lint", () => {
	it("accepts the good fixture", () => {
		expect(render(join(FIXTURES, "good"))).toEqual([]);
	});

	it("reports every problem in the bad fixture with file and line", () => {
		expect(render(join(FIXTURES, "bad"))).toEqual([
			'README.md:1: missing section "## Driving conventions"',
			'README.md:16: Features link "./missing.md" does not resolve',
			'README.md:17: Features link "https://example.com/feature.md" is external; link a local feature file',
			"orphan.md:1: feature file is not linked from README.md",
			'orphan.md:13: H2 3 must be "Driving it with <harness>", found "Driving it with"',
			"structure.md:1: missing a description paragraph between the H1 and the first H2",
			'structure.md:2: expected exactly 4 H2 sections, found 5: "Sub-features", "Driving it with drive-tally", "How to get to it (user POV)", "Gotchas", "Extra"',
			'structure.md:6: H2 2 must be "How to get to it (user POV)", found "Driving it with drive-tally"',
			'structure.md:6: driving section has no "Preconditions:" line',
			'structure.md:10: H2 3 must be "Driving it with <harness>", found "How to get to it (user POV)"',
			"structure.md:22: more than one H1",
		]);
	});

	it("reports a missing README", () => {
		const directory = mkdtempSync(join(tmpdir(), "feature-map-"));
		try {
			expect(render(directory)).toEqual(["README.md:1: README.md is missing"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("ignores headings inside fenced code and requires a paragraph, not a list", () => {
		const text = [
			"# Title",
			"",
			"- a list is not a description",
			"",
			"## Sub-features",
			"```",
			"## Fake",
			"```",
			"## How to get to it (user POV)",
			"## Driving it with any-harness",
			"Preconditions: none",
			"## Gotchas",
		].join("\n");
		expect(lintFeature(parseDocument(text))).toEqual([
			{ line: 1, message: "missing a description paragraph between the H1 and the first H2" },
		]);
	});
});

describe("cli", () => {
	it("prints usage on --help and exits non-zero on invalid input", () => {
		const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage: feature-map-lint");
		const none = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
		expect(none.status).toBe(2);
		const missing = spawnSync(process.execPath, [CLI, join(FIXTURES, "nope")], {
			encoding: "utf8",
		});
		expect(missing.status).toBe(2);
		const bad = spawnSync(process.execPath, [CLI, join(FIXTURES, "bad")], { encoding: "utf8" });
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("bad/structure.md:22: more than one H1");
		const good = spawnSync(process.execPath, [CLI, join(FIXTURES, "good")], { encoding: "utf8" });
		expect(good.status).toBe(0);
	});
});
