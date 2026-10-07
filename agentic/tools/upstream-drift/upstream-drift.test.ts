// Goal: the drift report lists upstream files changed since each item's recorded commit, for
// items declared in all three provenance sources. Method: build a throwaway upstream git repo
// with two commits and a project root that records the first commit.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "./cli.ts";
import { parseSkillsReadme, readProvenance } from "./upstream-drift.ts";

const CLI = join(import.meta.dir, "cli.ts");
let workspace = "";
let upstream = "";
let root = "";
let base = "";

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function git(...args: string[]): string {
	const result = spawnSync("git", ["-C", upstream, ...args], { encoding: "utf8" });
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

function commit(message: string): string {
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
	return git("rev-parse", "HEAD");
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "upstream-drift-"));
	upstream = join(workspace, "upstream");
	root = join(workspace, "project");
	mkdirSync(upstream);
	git("init", "--quiet");
	write(join(upstream, "pkg/skills/alpha/SKILL.md"), "alpha v1\n");
	write(join(upstream, "pkg/skills/beta/SKILL.md"), "beta v1\n");
	write(join(upstream, "pkg/tools/gamma/run.ts"), "gamma v1\n");
	base = commit("base");
	write(join(upstream, "pkg/skills/alpha/SKILL.md"), "alpha v2\nmore\n");
	write(join(upstream, "pkg/skills/alpha/extra.md"), "new\n");
	commit("change alpha");
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	const io = {
		stdout: (text: string) => void out.push(text),
		stderr: (text: string) => void err.push(text),
		env: {},
	};
	return { io, out, err };
}

function writeAllSources(): void {
	write(
		join(root, "skills/README.md"),
		[
			"# Skills",
			"",
			"| Skill | Local | Upstream path | Commit |",
			"|---|---|---|---|",
			`| Alpha | [skills/alpha](./alpha) | \`pkg/skills/alpha\` | ${base.slice(0, 7)} |`,
			`| Beta | skills/beta | pkg/skills/beta | ${base} |`,
			"",
		].join("\n"),
	);
	write(
		join(root, "agentic/vendor/gamma/PROVENANCE"),
		`upstream_repo: example\nupstream_path: pkg/tools/gamma\ncommit: ${base}\n\nnotes: ignored\n`,
	);
	write(
		join(root, "provenance.toml"),
		`[[item]]\nlocal = "agentic/vendor/gamma"\nupstream_path = "pkg/tools/gamma"\ncommit = "${base}"\n`,
	);
}

describe("upstream-drift", () => {
	it("reads all three sources, merging identical items", () => {
		writeAllSources();
		const provenance = readProvenance(root);
		expect(provenance.errors).toEqual([]);
		expect(provenance.items.map((i) => `${i.local} ${i.upstreamPath}`)).toEqual([
			"agentic/vendor/gamma pkg/tools/gamma",
			"skills/alpha pkg/skills/alpha",
			"skills/beta pkg/skills/beta",
		]);
	});

	it("keeps one item per upstream source of a local path", () => {
		write(
			join(root, "skills/README.md"),
			[
				"| Local | Upstream path | Commit |",
				"|---|---|---|",
				`| skills/merged | pkg/skills/beta | ${base} |`,
				`| skills/merged | pkg/skills/alpha | ${base} |`,
				"",
			].join("\n"),
		);
		const provenance = readProvenance(root);
		expect(provenance.errors).toEqual([]);
		expect(provenance.items.map((i) => `${i.local} ${i.upstreamPath}`)).toEqual([
			"skills/merged pkg/skills/alpha",
			"skills/merged pkg/skills/beta",
		]);
	});

	it("reports changed upstream files per item and exits 0", () => {
		writeAllSources();
		const run = capture();
		expect(main(["--root", root, "--upstream", upstream], run.io)).toBe(0);
		const text = run.out.join("");
		expect(text).toContain("skills/alpha <- pkg/skills/alpha");
		expect(text).toContain("2 files changed upstream\n");
		expect(text).toContain("  +2 -1 pkg/skills/alpha/SKILL.md\n");
		expect(text).toContain("  +1 -0 pkg/skills/alpha/extra.md\n");
		expect(text).toMatch(/skills\/beta .*: no drift/);
		expect(text).toMatch(/agentic\/vendor\/gamma .*: no drift/);
		expect(text).toContain("3 items, 1 drifted, 0 errors");
	});

	it("exits 1 on drift with --fail-on-drift", () => {
		writeAllSources();
		expect(main(["--root", root, "--upstream", upstream, "--fail-on-drift"], capture().io)).toBe(1);
	});

	it("reports unknown commits, missing paths and conflicting sources as errors", () => {
		const head = git("rev-parse", "HEAD");
		write(
			join(root, "provenance.toml"),
			[
				`[[item]]\nlocal = "a"\nupstream_path = "pkg/skills/alpha"\ncommit = "${"0".repeat(40)}"`,
				`[[item]]\nlocal = "b"\nupstream_path = "pkg/skills/nope"\ncommit = "${base}"`,
				`[[item]]\nlocal = "c"\nupstream_path = "pkg/skills/beta"\ncommit = "--output=x"`,
				`[[item]]\nlocal = "agentic/vendor/b"\nupstream_path = "pkg/skills/beta"\ncommit = "${head}"`,
			].join("\n"),
		);
		write(join(root, "agentic/vendor/b/PROVENANCE"), `upstream_path: pkg/skills/beta\ncommit: ${base}\n`);
		write(join(root, "agentic/vendor/b2/PROVENANCE"), "no keys here\n");
		const run = capture();
		expect(main(["--root", root, "--upstream", upstream], run.io)).toBe(1);
		const text = run.out.join("");
		expect(text).toContain(`commit ${"0".repeat(40)} not found upstream`);
		expect(text).toContain(`pkg/skills/nope does not exist at ${base}`);
		expect(text).toContain('commit "--output=x" is not a hex SHA');
		const errors = run.err.join("");
		expect(errors).toContain("agentic/vendor/b2/PROVENANCE: needs upstream_path and commit");
		expect(errors).toContain(
			`agentic/vendor/b <- pkg/skills/beta: agentic/vendor/b/PROVENANCE says ${base}` +
				` but provenance.toml item 4 says ${head}`,
		);
	});

	it("flags provenance rows with empty cells", () => {
		const errors: string[] = [];
		const text = "| Local | Upstream path | Commit |\n|---|---|---|\n| skills/x |  | abc1234 |\n";
		expect(parseSkillsReadme(text, "skills/README.md", errors)).toEqual([]);
		expect(errors).toEqual([
			"skills/README.md:3: provenance row needs Local, Upstream path and Commit",
		]);
	});

	it("prints usage on --help and exits non-zero on invalid input", () => {
		const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage: upstream-drift");
		const bad = spawnSync(process.execPath, [CLI, "--bogus"], { encoding: "utf8" });
		expect(bad.status).toBe(2);
		const missing = spawnSync(process.execPath, [CLI, "--root", join(workspace, "nope")], {
			encoding: "utf8",
		});
		expect(missing.status).toBe(2);
	});

	it("reads items from another upstream repository through --upstream-for, and errors without its checkout", () => {
		write(join(root, "skills/README.md"), "# Skills\n");
		write(join(root, "provenance.toml"), `[[item]]\nlocal = "skills/alpha"\nrepo = "other/skills"\nupstream_path = "pkg/skills/alpha"\ncommit = "${base}"\n`);
		expect(readProvenance(root).items).toEqual([expect.objectContaining({ local: "skills/alpha", repo: "other/skills" })]);
		const withCheckout = capture();
		expect(main(["--root", root, "--upstream", upstream, "--upstream-for", `other/skills=${upstream}`], withCheckout.io)).toBe(0);
		expect(withCheckout.out.join("")).toContain("skills/alpha <- other/skills:pkg/skills/alpha");
		expect(withCheckout.out.join("")).toContain("2 files changed upstream");
		const withoutCheckout = capture();
		expect(main(["--root", root, "--upstream", upstream], withoutCheckout.io)).toBe(1);
		expect(withoutCheckout.out.join("")).toContain("no checkout for other/skills");
	});
});
