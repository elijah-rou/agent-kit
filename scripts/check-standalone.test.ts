import { describe, expect, test } from "bun:test";
import { isExempt, PENDING, violations } from "./check-standalone.ts";

describe("standalone check", () => {
	test.each([
		["the installer by name", "Bootstrap links the export."],
		["the installer's environment variable", "the root is BOOTSTRAP_ROOT"],
		["the installer's possessive", "bootstrap's pin"],
		["the installer's install path", "under ~/.local/share/bootstrap"],
		["the user's dotfiles", "Copyright (c) 2026 dotfiles contributors"],
		["a machine-specific checkout path", "default ~/Projects/cursor-plugins"],
	])("%s is refused", (_, line) => {
		const found = violations("skills/x/SKILL.md", `ok\n${line}\n`);
		expect(found).toHaveLength(1);
		expect(found[0]).toStartWith("skills/x/SKILL.md:2: names ");
	});

	test("the verb's other forms pass", () => {
		expect(violations("skills/code-design/SKILL.md", "places that need a shell script, such as bootstrapping before the toolchain exists")).toEqual([]);
	});

	test.each(["docs/analysis/2026-10-07-x.md", "plans/x.md", "skills/show-me/HUMANLAYER-LICENSE", "agentic/vendor/orch/PROVENANCE", "provenance.toml"])(
		"%s is a dated record or attribution and is exempt",
		path => {
			expect(isExempt(path)).toBe(true);
			expect(violations(path, "bootstrap.ts")).toEqual([]);
		},
	);

	test("a pending phrase passes only in its own file, and any other mention there still fails", () => {
		for (const { path, phrase } of PENDING) {
			expect(violations(path, `a ${phrase} b`)).toEqual([]);
			expect(violations(path, `a ${phrase} b, and bootstrap links it`)).toHaveLength(1);
			expect(violations("skills/x/SKILL.md", phrase)).toHaveLength(1);
		}
	});

	test("a file named like an exempt one elsewhere is not exempt", () => {
		expect(isExempt("docs/design/analysis.md")).toBe(false);
		expect(isExempt("skills/PROVENANCE.md")).toBe(false);
	});
});
