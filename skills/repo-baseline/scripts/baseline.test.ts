import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { apply, audit, createIfAbsent, README_STUB, type ItemId, type Report } from "./baseline.ts";

const SCRIPT = join(import.meta.dir, "baseline.ts");
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-baseline-"));
	made.push(dir);
	return dir;
}
const status = (report: Report) => Object.fromEntries(report.items.map(item => [item.id, item.status])) as Record<ItemId, string>;

// Every path under dir (git internals excluded) with its mode and content, to compare whole trees.
function snapshot(dir: string): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
		if (name === ".git" || name.startsWith(".git/")) continue;
		const path = join(dir, name);
		const stat = statSync(path);
		entries[relative(dir, path)] = stat.isDirectory() ? "dir" : `${(stat.mode & 0o777).toString(8)} ${readFileSync(path, "utf8")}`;
	}
	return entries;
}

describe("audit", () => {
	test("an empty directory reports every item and changes nothing", () => {
		const dir = scratch();
		const report = audit(dir);
		expect(status(report)).toEqual({
			git: "create",
			gitignore: "create",
			readme: "create",
			license: "decision",
			validate: "manual",
			"agents-md": "create",
			"claude-md": "optional",
			"secret-hook": "optional",
			remote: "optional",
			ci: "optional",
			ruleset: "optional",
			"jev-opt-out": "decision",
		});
		expect(report.items.find(item => item.id === "license")!.detail).toContain("propose MIT");
		expect(report.items.find(item => item.id === "jev-opt-out")!.detail).toContain("default not opted out");
		expect(report.validate).toBeNull();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("the CLI audit exits 0, prints JSON without file contents, and leaves the directory empty", () => {
		const dir = scratch();
		const result = spawnSync(process.execPath, [SCRIPT, "audit", dir, "--json"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.items).toHaveLength(12);
		expect(result.stdout).not.toContain("Permission is hereby granted");
		expect(result.stdout).not.toContain('"action"');
		expect(readdirSync(dir)).toEqual([]);
	});

	test("validate uses only the repository's own commands", () => {
		const dir = scratch();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: 'echo "Error: no test specified" && exit 1' } }));
		writeFileSync(join(dir, "bun.lock"), "");
		writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
		const report = audit(dir);
		const validate = report.items.find(item => item.id === "validate")!;
		expect(validate.status).toBe("create");
		expect(validate.detail).toBe("scripts/validate running bun run lint; cargo clippy --all-targets -- -D warnings; cargo test");
	});

	test("a make target for a kind stands for that kind; an existing validate target is the entry point", () => {
		const dir = scratch();
		writeFileSync(join(dir, "go.mod"), "module x\n");
		writeFileSync(join(dir, "Makefile"), "VAR := 1\ntest:\n\tgo test ./...\n");
		expect(audit(dir).items.find(item => item.id === "validate")!.detail).toBe("scripts/validate running go vet ./...; make test");
		writeFileSync(join(dir, "Makefile"), "validate: test\ntest:\n\tgo test ./...\n");
		const report = audit(dir);
		expect(report.validate).toBe("make validate");
		expect(status(report).validate).toBe("present");
	});
});

describe("apply", () => {
	test("a second apply creates nothing and changes nothing", () => {
		const dir = scratch();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc --noEmit" } }));
		writeFileSync(join(dir, "bun.lock"), "");
		const options = { license: "MIT" as const, holder: "Test Holder", claudeMd: true, secretHook: true };
		const first = apply(dir, options);
		expect(first.created).toEqual(["git repository", ".gitignore", "README.md", "LICENSE", "scripts/validate", "AGENTS.md", "CLAUDE.md", ".pre-commit-config.yaml"]);
		expect(first.report.items.filter(item => item.status === "create")).toEqual([]);
		expect(readFileSync(join(dir, "scripts/validate"), "utf8")).toContain("bun run typecheck\nbun run test\n");
		expect(statSync(join(dir, "scripts/validate")).mode & 0o111).not.toBe(0);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("`scripts/validate`");
		expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
		expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("node_modules/");
		expect(spawnSync("git", ["-C", dir, "symbolic-ref", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe("refs/heads/main");
		const before = snapshot(dir);
		const second = apply(dir, options);
		expect(second.created).toEqual([]);
		expect(second.skipped).toEqual([]);
		expect(snapshot(dir)).toEqual(before);
		// The stub README is the one item left for a person; nothing else needs action.
		expect(status(second.report).readme).toBe("manual");
	});

	test("never overwrites an existing file", () => {
		const dir = scratch();
		spawnSync("git", ["init", "-q", dir]);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ license: "MIT", scripts: { test: "bun test" } }));
		const mine = { ".gitignore": "mine\n", "README.md": "# Mine\n", "LICENSE": "my license\n", "AGENTS.md": "my agents\n", ".pre-commit-config.yaml": "repos: []\n" };
		for (const [name, text] of Object.entries(mine)) writeFileSync(join(dir, name), text);
		mkdirSync(join(dir, "scripts"));
		writeFileSync(join(dir, "scripts/validate"), "my validate\n", { mode: 0o700 });
		const before = snapshot(dir);
		const result = apply(dir, { license: "MIT", holder: "X", claudeMd: true, secretHook: true });
		expect(result.created).toEqual(["CLAUDE.md"]);
		const after = snapshot(dir);
		delete after["CLAUDE.md"];
		expect(after).toEqual(before);
		// Gaps in existing files are reported for a person, not patched.
		expect(status(result.report)).toMatchObject({ gitignore: "manual", "agents-md": "manual", "secret-hook": "manual" });
	});

	test("a file that appears after the audit is left as is", () => {
		const dir = scratch();
		const path = join(dir, "README.md");
		writeFileSync(path, "theirs\n");
		expect(createIfAbsent(path, "ours\n", 0o644)).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("theirs\n");
		expect(readdirSync(dir)).toEqual(["README.md"]);
	});

	test("refuses inside another repository's subdirectory and creates nothing", () => {
		const dir = scratch();
		spawnSync("git", ["init", "-q", dir]);
		const nested = join(dir, "sub");
		mkdirSync(nested);
		expect(status(audit(nested)).git).toBe("manual");
		expect(() => apply(nested)).toThrow("refusing to apply");
		expect(readdirSync(nested)).toEqual([]);
		const cli = spawnSync(process.execPath, [SCRIPT, "apply", nested], { encoding: "utf8" });
		expect(cli.status).toBe(1);
		expect(cli.stderr).toContain("refusing to apply");
	});

	test("instructions only in CLAUDE.md are left for a person to move, not shadowed by a template", () => {
		const dir = scratch();
		writeFileSync(join(dir, "CLAUDE.md"), "Real conventions.\n");
		const result = apply(dir, { claudeMd: true });
		expect(result.created).not.toContain("AGENTS.md");
		expect(status(result.report)["agents-md"]).toBe("manual");
		expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("Real conventions.\n");
	});

	test("a license is written only when named or declared as MIT", () => {
		const declaredMit = scratch();
		writeFileSync(join(declaredMit, "package.json"), JSON.stringify({ license: "MIT" }));
		expect(apply(declaredMit, { holder: "X" }).created).toContain("LICENSE");
		const apache = scratch();
		writeFileSync(join(apache, "Cargo.toml"), '[package]\nname = "x"\nlicense = "Apache-2.0"\n');
		const report = apply(apache, { holder: "X" }).report;
		expect(status(report).license).toBe("manual");
		const conflict = scratch();
		writeFileSync(join(conflict, "package.json"), JSON.stringify({ license: "ISC" }));
		expect(status(apply(conflict, { license: "MIT", holder: "X" }).report).license).toBe("manual");
		expect(readdirSync(conflict)).not.toContain("LICENSE");
	});

	test("the CLI rejects a license it cannot write", () => {
		const result = spawnSync(process.execPath, [SCRIPT, "apply", scratch(), "--license", "GPL-3.0"], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("MIT only");
	});

	test("the README stub is reported until its marked line is replaced", () => {
		const dir = scratch();
		apply(dir);
		expect(readFileSync(join(dir, "README.md"), "utf8")).toContain(README_STUB);
		writeFileSync(join(dir, "README.md"), "# Real\n");
		expect(status(audit(dir)).readme).toBe("present");
	});
});
