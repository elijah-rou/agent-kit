import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { OPT_OUT_FILE } from "../../../agentic/tools/jev/egress.ts";
import { apply, audit, createIfAbsent, JEV_OPT_OUT, README_STUB, type ItemId, type Report } from "./baseline.ts";

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

	const validateDetail = (dir: string) => audit(dir).items.find(item => item.id === "validate")!.detail;

	test("validate skips npm's placeholder test script and a types script, and adds clippy only where the repository configures it", () => {
		const dir = scratch();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", types: "tsc --emitDeclarationOnly", test: 'echo "Error: no test specified" && exit 1' } }));
		writeFileSync(join(dir, "bun.lock"), "");
		writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\nversion = "0.1.0"\n');
		const report = audit(dir);
		expect(status(report).validate).toBe("create");
		expect(validateDetail(dir)).toBe("scripts/validate running bun run lint; cargo test");
		writeFileSync(join(dir, "clippy.toml"), "msrv = \"1.80\"\n");
		expect(validateDetail(dir)).toBe("scripts/validate running bun run lint; cargo clippy; cargo test");
	});

	test("clippy from a [lints.clippy] table or a crate-level clippy attribute, never from a [lints.rust] table alone", () => {
		const lints = scratch();
		writeFileSync(join(lints, "Cargo.toml"), '[package]\nname = "x"\n\n[lints.clippy]\nunwrap_used = "deny"\n');
		expect(validateDetail(lints)).toBe("scripts/validate running cargo clippy; cargo test");
		const workspace = scratch();
		writeFileSync(join(workspace, "Cargo.toml"), '[workspace]\nmembers = ["a"]\n\n[workspace.lints.clippy]\npedantic = "warn"\n');
		expect(validateDetail(workspace)).toBe("scripts/validate running cargo clippy; cargo test");
		const inline = scratch();
		writeFileSync(join(inline, "Cargo.toml"), '[package]\nname = "x"\n');
		mkdirSync(join(inline, "src"));
		writeFileSync(join(inline, "src/lib.rs"), "#![deny(clippy::all, missing_docs)]\n");
		expect(validateDetail(inline)).toBe("scripts/validate running cargo clippy; cargo test");
		const rustOnly = scratch();
		writeFileSync(join(rustOnly, "Cargo.toml"), '[package]\nname = "x"\n\n[lints.rust]\nunsafe_code = "forbid"\n');
		expect(validateDetail(rustOnly)).toBe("scripts/validate running cargo test");
	});

	// Each fixture once produced a broken scripts/validate line copied out of CI, a makefile, or a justfile.
	const copyTraps: [string, string, string, string][] = [
		["a step name before its run line", ".github/workflows/ci.yml", "jobs:\n  lint:\n    steps:\n      - name: cargo clippy (deny warnings)\n        run: cargo clippy --workspace -- -D warnings\n", "cargo clippy"],
		["a comment mentioning the check", "Makefile", "# go vet here once the tree is clean\nbuild:\n\tgo build ./...\n", "go vet"],
		["a multi-line run with a continuation", ".github/workflows/ci.yml", "jobs:\n  lint:\n    steps:\n      - run: |\n          cargo clippy --all-targets \\\n            -- -D warnings\n          cargo fmt --check\n", "cargo clippy"],
		["a justfile recipe body", "justfile", "vet:\n    go vet ./... && echo ok\n", "go vet"],
	];
	for (const [name, path, content, command] of copyTraps) {
		test(`nothing is copied out of ${name}; validate stays valid bash`, () => {
			const dir = scratch();
			writeFileSync(join(dir, command === "go vet" ? "go.mod" : "Cargo.toml"), command === "go vet" ? "module x\n" : '[package]\nname = "x"\n');
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
			const report = apply(dir).report;
			const validate = readFileSync(join(dir, "scripts/validate"), "utf8");
			const body = validate.split("\n").filter(line => line !== "" && !line.startsWith("#") && !line.startsWith("set ") && !line.startsWith("cd "));
			expect(body).toEqual([command === "go vet" ? "go test ./..." : "cargo test"]);
			expect(spawnSync("bash", ["-n", join(dir, "scripts/validate")]).status).toBe(0);
			const gap = report.items.find(item => item.id === "validate-gap");
			if (name.startsWith("a comment")) expect(gap).toBeUndefined();
			else {
				expect(gap).toEqual({ id: "validate-gap", status: "manual", detail: `${path} runs ${command}, which nothing configures; add it to validate if the repository wants it locally` });
				writeFileSync(join(dir, "scripts/validate"), `${validate}${command}\n`);
				expect(status(audit(dir))["validate-gap"]).toBeUndefined();
			}
		});
	}

	test("configured clippy is the plain invocation even when CI runs it with its own flags", () => {
		const dir = scratch();
		writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
		writeFileSync(join(dir, "clippy.toml"), "");
		mkdirSync(join(dir, ".github/workflows"), { recursive: true });
		writeFileSync(join(dir, ".github/workflows/ci.yml"), "jobs:\n  lint:\n    steps:\n      - run: cargo clippy --workspace -- -D warnings\n");
		const report = audit(dir);
		expect(report.items.find(item => item.id === "validate")!.detail).toBe("scripts/validate running cargo clippy; cargo test");
		expect(report.items.find(item => item.id === "validate-gap")).toBeUndefined();
	});

	test("go vet is never generated: with no make or just target named for linting it is a manual note", () => {
		const bare = scratch();
		writeFileSync(join(bare, "go.mod"), "module x\n");
		expect(validateDetail(bare)).toBe("scripts/validate running go test ./...");
		writeFileSync(join(bare, "Makefile"), "vet:\n\tgo vet ./cmd/...\n");
		expect(validateDetail(bare)).toBe("scripts/validate running go test ./...");
		expect(status(audit(bare))["validate-gap"]).toBe("manual");
		writeFileSync(join(bare, "Makefile"), "lint:\n\tgo vet ./cmd/...\n");
		expect(validateDetail(bare)).toBe("scripts/validate running make lint; go test ./...");
		expect(status(audit(bare))["validate-gap"]).toBeUndefined();
	});

	test("mypy keeps the files its configuration names", () => {
		const configured = scratch();
		writeFileSync(join(configured, "pyproject.toml"), '[project]\nname = "x"\n\n[tool.mypy]\nfiles = ["src"]\n');
		expect(validateDetail(configured)).toBe("scripts/validate running mypy");
		const unset = scratch();
		writeFileSync(join(unset, "pyproject.toml"), '[project]\nname = "x"\n\n[tool.mypy]\nstrict = true\n');
		expect(validateDetail(unset)).toBe("scripts/validate running mypy .");
		const ini = scratch();
		writeFileSync(join(ini, "requirements.txt"), "");
		writeFileSync(join(ini, "mypy.ini"), "[mypy]\nfiles = src, tests\n");
		expect(validateDetail(ini)).toBe("scripts/validate running mypy");
		writeFileSync(join(ini, "mypy.ini"), "[mypy]\nstrict = True\n\n[mypy-tests.*]\nfiles = tests\n");
		expect(validateDetail(ini)).toBe("scripts/validate running mypy .");
	});

	test("a make target for a kind stands for that kind; an existing validate target is the entry point", () => {
		const dir = scratch();
		writeFileSync(join(dir, "go.mod"), "module x\n");
		writeFileSync(join(dir, "Makefile"), "VAR := 1\ntest:\n\tgo test ./...\n");
		expect(validateDetail(dir)).toBe("scripts/validate running make test");
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

	test("instructions in .claude/CLAUDE.md count as existing: no template AGENTS.md and no root CLAUDE.md", () => {
		const dir = scratch();
		mkdirSync(join(dir, ".claude"));
		writeFileSync(join(dir, ".claude/CLAUDE.md"), "Real conventions.\n");
		const result = apply(dir, { claudeMd: true });
		expect(result.created).not.toContain("AGENTS.md");
		expect(result.created).not.toContain("CLAUDE.md");
		expect(status(result.report)).toMatchObject({ "agents-md": "manual", "claude-md": "present" });
		expect(readdirSync(dir)).not.toContain("CLAUDE.md");
		expect(readdirSync(join(dir, ".claude"))).toEqual(["CLAUDE.md"]);
	});

	test("instructions only in another file Claude Code or Pi loads leave AGENTS.md and CLAUDE.md for a person", () => {
		for (const name of ["CLAUDE.local.md", "AGENTS.override.md"]) {
			const dir = scratch();
			writeFileSync(join(dir, name), "Real conventions.\n");
			const result = apply(dir, { claudeMd: true });
			expect(result.created).not.toContain("AGENTS.md");
			expect(result.created).not.toContain("CLAUDE.md");
			expect(status(result.report)["agents-md"]).toBe("manual");
		}
	});

	test("a .claude directory alone creates no CLAUDE.md; --claude-md does", () => {
		const dir = scratch();
		mkdirSync(join(dir, ".claude"));
		writeFileSync(join(dir, ".claude/settings.json"), "{}\n");
		const result = apply(dir);
		expect(result.created).toContain("AGENTS.md");
		expect(result.created).not.toContain("CLAUDE.md");
		expect(status(result.report)["claude-md"]).toBe("optional");
		expect(apply(dir, { claudeMd: true }).created).toEqual(["CLAUDE.md"]);
	});

	test("a declared MIT license names the manifest's author, and without one asks for a holder instead of using git user.name", () => {
		const authored = scratch();
		writeFileSync(join(authored, "package.json"), JSON.stringify({ license: "MIT", author: "Ada Lovelace <ada@example.com> (https://example.com)" }));
		expect(apply(authored).created).toContain("LICENSE");
		expect(readFileSync(join(authored, "LICENSE"), "utf8")).toContain(`Copyright (c) ${new Date().getFullYear()} Ada Lovelace\n`);
		const cargo = scratch();
		writeFileSync(join(cargo, "Cargo.toml"), '[package]\nname = "x"\nlicense = "MIT"\nauthors = ["Grace Hopper <grace@example.com>"]\n');
		apply(cargo);
		expect(readFileSync(join(cargo, "LICENSE"), "utf8")).toContain(" Grace Hopper\n");
		const anonymous = scratch();
		spawnSync("git", ["init", "-q", anonymous]);
		spawnSync("git", ["-C", anonymous, "config", "user.name", "Git User"]);
		writeFileSync(join(anonymous, "package.json"), JSON.stringify({ license: "MIT" }));
		const report = apply(anonymous).report;
		expect(status(report).license).toBe("decision");
		expect(report.items.find(item => item.id === "license")!.detail).toContain("holder");
		expect(readdirSync(anonymous)).not.toContain("LICENSE");
		expect(apply(anonymous, { holder: "Named Holder" }).created).toContain("LICENSE");
	});

	test("with --license MIT the manifest's author holds the copyright before git user.name", () => {
		const named = scratch();
		spawnSync("git", ["init", "-q", named]);
		spawnSync("git", ["-C", named, "config", "user.name", "Git User"]);
		writeFileSync(join(named, "Cargo.toml"), '[package]\nname = "x"\nauthors = ["Grace Hopper <grace@example.com>"]\n');
		apply(named, { license: "MIT" });
		expect(readFileSync(join(named, "LICENSE"), "utf8")).toContain(" Grace Hopper\n");
		const unnamed = scratch();
		spawnSync("git", ["init", "-q", unnamed]);
		spawnSync("git", ["-C", unnamed, "config", "user.name", "Git User"]);
		apply(unnamed, { license: "MIT" });
		expect(readFileSync(join(unnamed, "LICENSE"), "utf8")).toContain(" Git User\n");
	});

	test("the secret hook pins gitleaks to a commit, not a tag", () => {
		const dir = scratch();
		apply(dir, { secretHook: true });
		expect(readFileSync(join(dir, ".pre-commit-config.yaml"), "utf8")).toMatch(/^    rev: [0-9a-f]{40}  # frozen: v\d+\.\d+\.\d+$/m);
	});

	test("a hard link that fails leaves no temporary file and names the requirement", () => {
		const dir = scratch();
		const link = spyOn(fs, "linkSync").mockImplementation(() => {
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		});
		try {
			expect(() => createIfAbsent(join(dir, "README.md"), "ours\n", 0o644)).toThrow("hard links");
		} finally {
			link.mockRestore();
		}
		expect(readdirSync(dir)).toEqual([]);
	});

	test("a write that fails partway leaves no temporary file", () => {
		const dir = scratch();
		const realWrite = fs.writeFileSync;
		const write = spyOn(fs, "writeFileSync").mockImplementation((path: fs.PathOrFileDescriptor) => {
			realWrite(path, "partial");
			throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		});
		try {
			expect(() => createIfAbsent(join(dir, "README.md"), "ours\n", 0o644)).toThrow("no space left");
		} finally {
			write.mockRestore();
		}
		expect(readdirSync(dir)).toEqual([]);
	});

	test("the opt-out path matches the one Jev's egress checks", () => {
		expect(JEV_OPT_OUT).toBe(OPT_OUT_FILE);
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
