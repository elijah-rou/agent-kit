#!/usr/bin/env bun
// repo-baseline: audit or apply a repository's baseline. `audit` reports what is present or missing and changes
// nothing. `apply` creates only what is missing and never overwrites a file: each file is written to a temporary
// name and hard-linked into place, which fails when the target exists, so a race or a rerun never clobbers anything
// and an interrupted write never leaves a partial file behind under the real name.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const USAGE = `Usage: baseline.ts <audit | apply> [DIR] [--json] [--license MIT] [--holder NAME] [--claude-md] [--secret-hook]

Set up or adopt a repository's baseline. DIR defaults to the current directory and must be the repository root.

  audit          Report each baseline item as present, create (apply will create it), manual (someone must act),
                 decision (the user's call, with the default), or optional (case by case, never by default).
                 Changes nothing.
  apply          Create every item marked create, then print the audit again. Never overwrites a file.

  --license MIT  The user named MIT: write LICENSE. A license the project's manifest declares as MIT is written
                 without this flag. Other licenses: add their canonical text by hand.
  --holder NAME  The copyright holder for LICENSE (default: git config user.name).
  --claude-md    Also create CLAUDE.md importing AGENTS.md (created anyway when a .claude directory exists).
  --secret-hook  The user asked for a secret-scan hook: with no hook manager, write a pre-commit config with gitleaks.
  --json         Print the report as JSON.

Exit status: 0 done, 1 failure or refusal, 2 usage error.
`;

export type Status = "present" | "create" | "manual" | "decision" | "optional";
export type ItemId = "git" | "gitignore" | "readme" | "license" | "validate" | "agents-md" | "claude-md" | "secret-hook" | "remote" | "ci" | "ruleset" | "jev-opt-out";
type Action = { kind: "git-init" } | { kind: "file"; path: string; content: string; mode: number };
export interface Item {
	id: ItemId;
	status: Status;
	detail: string;
	action?: Action;
}
export interface Options {
	license?: "MIT";
	holder?: string;
	claudeMd?: boolean;
	secretHook?: boolean;
}
export type Stack = "node" | "rust" | "go" | "python" | "zig";
export interface Report {
	dir: string;
	stacks: Stack[];
	validate: string | null;
	items: Item[];
}
type Kind = "lint" | "typecheck" | "test";

const KINDS: Kind[] = ["lint", "typecheck", "test"];
const TASK_NAMES: Record<Kind, string[]> = { lint: ["lint"], typecheck: ["typecheck", "type-check", "check-types", "types"], test: ["test"] };
// The README stub carries this line until someone replaces it, so audit can tell a stub from a real README.
export const README_STUB = "_Replace this line: what this project does, for whom, and how to run it._";
export const JEV_OPT_OUT = ".agents/jev-opt-out";
// Pinned to a release tag; run `pre-commit autoupdate` to move it.
const GITLEAKS_REV = "v8.30.1";
const SECRET_SCANNERS = /\b(?:gitleaks|trufflehog|detect-secrets|git-secrets|ggshield)\b/;
const IGNORE_ALWAYS = [".DS_Store", ".env", ".env.*", "!.env.example"];
const IGNORE_BY_STACK: Record<Stack, string[]> = {
	node: ["node_modules/", "dist/", "coverage/"],
	rust: ["target/"],
	go: [],
	python: ["__pycache__/", "*.py[cod]", ".venv/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "*.egg-info/"],
	zig: [".zig-cache/", "zig-out/"],
};
// What an existing .gitignore should cover, checked by matching each path against its patterns.
const IGNORE_EXPECTED: Record<Stack | "all", string[]> = { all: [".env"], node: ["node_modules"], rust: ["target"], go: [], python: ["__pycache__", ".venv"], zig: [".zig-cache", "zig-out"] };

const exists = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};
const read = (path: string): string => (exists(path) ? readFileSync(path, "utf8") : "");

function git(dir: string, args: string[]): { ok: boolean; out: string } {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	if (result.error) throw new Error(`git did not run: ${result.error.message}`);
	return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

function packageJson(dir: string): Record<string, unknown> | undefined {
	const text = read(join(dir, "package.json"));
	if (text === "") return undefined;
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json is not a JSON object");
	return parsed as Record<string, unknown>;
}

function toml(dir: string, name: string): Record<string, unknown> | undefined {
	const text = read(join(dir, name));
	return text === "" ? undefined : (Bun.TOML.parse(text) as Record<string, unknown>);
}

const field = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((at, key) => (at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined), value);

export function detectStacks(dir: string): Stack[] {
	const has = (name: string) => exists(join(dir, name));
	const stacks: Stack[] = [];
	if (has("package.json")) stacks.push("node");
	if (has("Cargo.toml")) stacks.push("rust");
	if (has("go.mod")) stacks.push("go");
	if (["pyproject.toml", "requirements.txt", "setup.py", "uv.lock"].some(has)) stacks.push("python");
	if (has("build.zig")) stacks.push("zig");
	return stacks;
}

function nodeRunner(dir: string): string {
	const has = (name: string) => exists(join(dir, name));
	if (has("bun.lock") || has("bun.lockb")) return "bun run";
	if (has("pnpm-lock.yaml")) return "pnpm run";
	if (has("yarn.lock")) return "yarn run";
	return "npm run";
}

function nodeScripts(dir: string): Record<string, string> {
	const scripts = field(packageJson(dir), "scripts");
	if (scripts === null || typeof scripts !== "object") return {};
	return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function makeTargets(dir: string): Set<string> {
	const text = ["GNUmakefile", "makefile", "Makefile"].map(name => read(join(dir, name))).join("\n");
	return new Set([...text.matchAll(/^([A-Za-z0-9_.-]+)[ \t]*:(?!=)/gm)].map(match => match[1]!));
}

function justRecipes(dir: string): Set<string> {
	const text = ["justfile", "Justfile", ".justfile"].map(name => read(join(dir, name))).join("\n");
	return new Set([...text.matchAll(/^@?([A-Za-z0-9_-]+)(?:[ \t][^:\n]*)?:(?!=)/gm)].map(match => match[1]!));
}

// Every validate entry point the repository already has.
export function existingValidate(dir: string): string[] {
	const found: string[] = [];
	if (exists(join(dir, "scripts/validate"))) found.push("scripts/validate");
	if (makeTargets(dir).has("validate")) found.push("make validate");
	if (justRecipes(dir).has("validate")) found.push("just validate");
	if ("validate" in nodeScripts(dir)) found.push(`${nodeRunner(dir)} validate`);
	return found;
}

// The repository's own lint, type-check, and test commands. A just recipe or make target for a kind stands for
// that kind; otherwise each stack contributes the commands its configuration shows. Nothing here adds a tool the
// repository does not already use.
export function detectCommands(dir: string, stacks: Stack[]): string[] {
	const recipes = justRecipes(dir);
	const targets = makeTargets(dir);
	const scripts = nodeScripts(dir);
	const runner = nodeRunner(dir);
	const pyproject = read(join(dir, "pyproject.toml"));
	const has = (name: string) => exists(join(dir, name));
	const uv = has("uv.lock") ? "uv run " : "";
	const commands: string[] = [];
	for (const kind of KINDS) {
		const recipe = TASK_NAMES[kind].find(name => recipes.has(name));
		if (recipe !== undefined) { commands.push(`just ${recipe}`); continue; }
		const target = TASK_NAMES[kind].find(name => targets.has(name));
		if (target !== undefined) { commands.push(`make ${target}`); continue; }
		for (const stack of stacks) {
			switch (stack) {
				case "node": {
					const script = TASK_NAMES[kind].find(name => name in scripts);
					// npm init's placeholder test script always fails; it is not a test command.
					if (script !== undefined && !/no test specified/.test(scripts[script]!)) commands.push(`${runner} ${script}`);
					break;
				}
				case "rust":
					if (kind === "lint") commands.push("cargo clippy --all-targets -- -D warnings");
					if (kind === "test") commands.push("cargo test");
					break;
				case "go":
					if (kind === "lint") commands.push("go vet ./...");
					if (kind === "test") commands.push("go test ./...");
					break;
				case "python":
					if (kind === "lint" && (pyproject.includes("[tool.ruff") || has("ruff.toml") || has(".ruff.toml"))) commands.push(`${uv}ruff check .`);
					if (kind === "typecheck" && (pyproject.includes("[tool.mypy") || has("mypy.ini"))) commands.push(`${uv}mypy .`);
					if (kind === "typecheck" && (pyproject.includes("[tool.pyright") || has("pyrightconfig.json"))) commands.push(`${uv}pyright`);
					if (kind === "test" && (pyproject.includes("pytest") || has("pytest.ini") || has("conftest.py"))) commands.push(`${uv}pytest`);
					break;
				case "zig":
					if (kind === "test" && /\.step\(\s*"test"/.test(read(join(dir, "build.zig")))) commands.push("zig build test");
					break;
			}
		}
	}
	return commands;
}

function declaredLicense(dir: string): string | undefined {
	const candidates = [
		field(packageJson(dir), "license"),
		field(toml(dir, "Cargo.toml"), "package", "license"),
		field(toml(dir, "pyproject.toml"), "project", "license"),
		field(toml(dir, "pyproject.toml"), "project", "license", "text"),
	];
	return candidates.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
}

function mitLicense(holder: string): string {
	return `MIT License

Copyright (c) ${new Date().getFullYear()} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

const file = (path: string, content: string, mode = 0o644): Action => ({ kind: "file", path, content, mode });

function gitignoreGaps(text: string, stacks: Stack[]): string[] {
	const patterns = text.split("\n").map(line => line.trim()).filter(line => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
		.map(line => line.replace(/^\/|\/$/g, "").replace(/^\*\*\//, ""));
	const expected = [...IGNORE_EXPECTED.all, ...stacks.flatMap(stack => IGNORE_EXPECTED[stack])];
	return expected.filter(path => !patterns.some(pattern => new Bun.Glob(pattern).match(path)));
}

function githubSlug(dir: string, remotes: string[]): string | undefined {
	for (const remote of remotes) {
		const url = git(dir, ["remote", "get-url", remote]).out;
		const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
		if (match) return `${match[1]}/${match[2]}`;
	}
	return undefined;
}

export function audit(target: string, options: Options = {}): Report {
	const dir = realpathSync(target);
	const at = (name: string) => join(dir, name);
	const has = (name: string) => exists(at(name));
	const items: Item[] = [];
	const add = (id: ItemId, status: Status, detail: string, action?: Action) => items.push({ id, status, detail, ...(action ? { action } : {}) });

	// git (mandatory)
	const top = git(dir, ["rev-parse", "--show-toplevel"]);
	const repository = top.ok && realpathSync(top.out) === dir;
	if (repository) add("git", "present", "git repository at this directory");
	else if (top.ok) add("git", "manual", `inside the repository at ${top.out}: run at its root, or ask the user before nesting a repository here; apply refuses`);
	else add("git", "create", "no git repository: git init -b main", { kind: "git-init" });

	const stacks = detectStacks(dir);

	// .gitignore
	if (has(".gitignore")) {
		const gaps = gitignoreGaps(read(at(".gitignore")), stacks);
		if (gaps.length === 0) add("gitignore", "present", ".gitignore covers the detected stack");
		else add("gitignore", "manual", `.gitignore does not ignore ${gaps.join(", ")}; add them by hand`);
	} else {
		const lines = [...IGNORE_ALWAYS, ...stacks.flatMap(stack => IGNORE_BY_STACK[stack])];
		add("gitignore", "create", `.gitignore for ${stacks.length > 0 ? stacks.join(", ") : "no detected stack"}`, file(".gitignore", `${lines.join("\n")}\n`));
	}

	// README
	const readme = readdirSync(dir).find(name => /^readme(?:\.[a-z]+)?$/i.test(name));
	if (readme === undefined) add("readme", "create", "README.md stub", file("README.md", `# ${basename(dir)}\n\n${README_STUB}\n`));
	else if (read(at(readme)).includes(README_STUB)) add("readme", "manual", `${readme} is still the baseline stub: replace its marked line with what the project does`);
	else add("readme", "present", readme);

	// LICENSE: written only when the user named one or the manifest declares MIT; otherwise a default to propose.
	const licenseFile = readdirSync(dir).find(name => /^(?:licen[cs]e|copying|unlicense)(?:[.-].*)?$/i.test(name));
	const declared = declaredLicense(dir);
	const holder = options.holder ?? (git(dir, ["config", "user.name"]).out || undefined);
	if (licenseFile !== undefined) add("license", "present", licenseFile);
	else if (options.license !== undefined && declared !== undefined && declared !== options.license) add("license", "manual", `the user named ${options.license} but the manifest declares ${declared}: ask which one holds`);
	else if (options.license === undefined && declared === "UNLICENSED") add("license", "decision", "the manifest says UNLICENSED (proprietary): no license file unless the user wants one");
	else if (options.license === undefined && declared !== undefined && declared !== "MIT") add("license", "manual", `the manifest declares ${declared}: add its canonical text as LICENSE (for example gh api licenses/${declared.toLowerCase()} -q .body)`);
	else if (options.license === undefined && declared === undefined) add("license", "decision", "no license: propose MIT as the default the user can change (apply --license MIT); this does not block anything");
	else if (holder === undefined) add("license", "manual", "MIT LICENSE needs a copyright holder: pass --holder or set git config user.name");
	else add("license", "create", `MIT LICENSE for ${holder}${options.license === undefined ? " (declared in the manifest)" : ""}`, file("LICENSE", mitLicense(holder)));

	// validate: one entry point that runs the repository's own lint, type checks, and tests.
	const entries = existingValidate(dir);
	let validate: string | null = entries[0] ?? null;
	if (entries.length > 0) add("validate", "present", entries.length === 1 ? entries[0]! : `${entries.join(", ")}: keep one and name it in AGENTS.md`);
	else {
		const commands = detectCommands(dir, stacks);
		if (commands.length === 0) add("validate", "manual", "no lint, type-check, or test command found: add the project's own commands, then rerun apply; nothing is invented");
		else {
			validate = "scripts/validate";
			const script = ["#!/usr/bin/env bash", "# The one validate entry point: the repository's own lint, type-check, and test commands. Run it before every commit and push.", "set -euo pipefail", 'cd "$(dirname "${BASH_SOURCE[0]}")/.."', "", ...commands, ""].join("\n");
			add("validate", "create", `scripts/validate running ${commands.join("; ")}`, file("scripts/validate", script, 0o755));
		}
	}

	// AGENTS.md, and CLAUDE.md importing it.
	if (has("AGENTS.md")) {
		if (validate !== null && !read(at("AGENTS.md")).includes(validate)) add("agents-md", "manual", `AGENTS.md does not name the validate command ${validate}: add it`);
		else add("agents-md", "present", "AGENTS.md");
	} else if (has("CLAUDE.md")) {
		add("agents-md", "manual", "CLAUDE.md holds the instructions: move them to AGENTS.md, then make CLAUDE.md the line @AGENTS.md");
	} else {
		const validateSection = validate === null
			? "There is no validate entry point yet. Once the project has tests, lint, or type checks, add `scripts/validate` and name it here."
			: `Run \`${validate}\` before every commit and push: it is the one command that runs this repository's checks.`;
		const conventions = stacks.length > 0 ? `- Stack: ${stacks.join(", ")}.\n` : "";
		const text = `# ${basename(dir)}\n\nInstructions for coding agents working in this repository.\n\n## Validate\n\n${validateSection}\n\n## Conventions\n\n${conventions}- Keep this file the one source of agent instructions; other instruction files import it.\n`;
		add("agents-md", "create", `AGENTS.md${validate === null ? " (no validate command yet)" : ` naming ${validate}`}`, file("AGENTS.md", text));
	}
	if (has("CLAUDE.md")) {
		const imports = read(at("CLAUDE.md")).split("\n").some(line => line.trim() === "@AGENTS.md");
		if (has("AGENTS.md") && !imports) add("claude-md", "manual", "CLAUDE.md does not import AGENTS.md: add the line @AGENTS.md");
		else add("claude-md", "present", "CLAUDE.md");
	} else if (options.claudeMd === true || has(".claude")) add("claude-md", "create", "CLAUDE.md importing AGENTS.md", file("CLAUDE.md", "@AGENTS.md\n"));
	else add("claude-md", "optional", "only for a runtime that reads CLAUDE.md: apply --claude-md creates it as an import of AGENTS.md");

	// Secret-scan pre-commit hook: only with a hook manager or when the user asks.
	const managers: [string, string[]][] = [
		["pre-commit", [".pre-commit-config.yaml", ".pre-commit-config.yml"]],
		["lefthook", ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]],
		["husky", [".husky"]],
	];
	const manager = managers.map(([name, paths]) => ({ name, paths: paths.filter(has) })).find(found => found.paths.length > 0);
	if (manager !== undefined) {
		const configs = manager.paths.flatMap(path => (lstatSync(at(path)).isDirectory() ? readdirSync(at(path)).map(name => join(path, name)).filter(sub => lstatSync(at(sub)).isFile()) : [path]));
		if (configs.some(path => SECRET_SCANNERS.test(read(at(path))))) add("secret-hook", "present", `${manager.name} runs a secret scanner`);
		else add("secret-hook", "manual", `${manager.name} (${manager.paths.join(", ")}) has no secret scanner: add a gitleaks hook to it`);
	} else if (options.secretHook === true) {
		const config = `repos:\n  - repo: https://github.com/gitleaks/gitleaks\n    rev: ${GITLEAKS_REV}\n    hooks:\n      - id: gitleaks\n`;
		add("secret-hook", "create", ".pre-commit-config.yaml with gitleaks; then run pre-commit install", file(".pre-commit-config.yaml", config));
	} else add("secret-hook", "optional", "no hook manager: add a secret-scan hook only if the user asks (apply --secret-hook)");

	// Remote, CI, and ruleset: case by case with the user's authorization, never by default. Remote names only:
	// a remote URL can carry a token.
	const remotes = repository ? git(dir, ["remote"]).out.split("\n").filter(Boolean) : [];
	if (remotes.length > 0) add("remote", "present", `remotes: ${remotes.join(", ")}`);
	else add("remote", "optional", "no remote: add one only with the user's authorization");
	const workflows = has(".github/workflows") ? readdirSync(at(".github/workflows")).filter(name => /\.ya?ml$/.test(name)).map(name => `.github/workflows/${name}`) : [];
	const ci = [...workflows, ...(has(".gitlab-ci.yml") ? [".gitlab-ci.yml"] : [])];
	if (ci.length === 0) add("ci", "optional", "no CI: add one that runs the validate command, only with the user's authorization");
	else if (validate !== null && !ci.some(path => read(at(path)).includes(validate))) add("ci", "manual", `CI (${ci.join(", ")}) does not run ${validate}`);
	else add("ci", "present", ci.join(", "));
	const slug = githubSlug(dir, remotes);
	if (slug === undefined) add("ruleset", "optional", "needs a GitHub remote first");
	else add("ruleset", "optional", `check with agentic rulesets plan ${slug}; apply only with the user's authorization`);

	// Jev opt-out: the user's call.
	if (has(JEV_OPT_OUT)) add("jev-opt-out", "present", `${JEV_OPT_OUT} exists: prompts from this repository are never sent to Jev`);
	else add("jev-opt-out", "decision", `the user's call; default not opted out (commit an empty ${JEV_OPT_OUT} to opt out)`);

	return { dir, stacks, validate, items };
}

// Create the file only if nothing exists at its path. Returns whether this call created it.
export function createIfAbsent(path: string, content: string, mode: number): boolean {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.repo-baseline-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
	writeFileSync(temporary, content, { flag: "wx", mode });
	try {
		linkSync(temporary, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		unlinkSync(temporary);
	}
}

export function apply(target: string, options: Options = {}): { created: string[]; skipped: string[]; report: Report } {
	const planned = audit(target, options);
	const git = planned.items.find(item => item.id === "git")!;
	if (git.status === "manual") throw new Error(`refusing to apply: ${git.detail}`);
	const created: string[] = [];
	const skipped: string[] = [];
	for (const item of planned.items) {
		const action = item.action;
		if (item.status !== "create" || action === undefined) continue;
		if (action.kind === "git-init") {
			const result = spawnSync("git", ["init", "-b", "main", planned.dir], { encoding: "utf8" });
			if (result.status !== 0) throw new Error(`git init failed: ${(result.stderr ?? "").trim()}`);
			created.push("git repository");
		} else if (createIfAbsent(join(planned.dir, action.path), action.content, action.mode)) created.push(action.path);
		else skipped.push(`${action.path} (appeared during apply; left as is)`);
	}
	return { created, skipped, report: audit(target, options) };
}

function print(report: Report): void {
	console.log(`repository: ${report.dir}`);
	console.log(`stack: ${report.stacks.length > 0 ? report.stacks.join(", ") : "none detected"}`);
	console.log(`validate: ${report.validate ?? "none"}`);
	for (const item of report.items) console.log(`${item.status.padEnd(9)} ${item.id.padEnd(12)} ${item.detail}`);
}

function main(argv: string[]): number {
	const [command, ...rest] = argv;
	if (command === "--help" || command === "-h") { console.log(USAGE); return 0; }
	if (command !== "audit" && command !== "apply") { console.error(USAGE); return 2; }
	const options: Options = {};
	let dir = ".";
	let json = false;
	for (let index = 0; index < rest.length; index++) {
		const argument = rest[index]!;
		const value = () => {
			const next = rest[++index];
			if (next === undefined) throw new UsageError(`${argument} needs a value`);
			return next;
		};
		switch (argument) {
			case "--json": json = true; break;
			case "--claude-md": options.claudeMd = true; break;
			case "--secret-hook": options.secretHook = true; break;
			case "--holder": options.holder = value(); break;
			case "--license": {
				const license = value();
				if (license !== "MIT") throw new UsageError(`--license supports MIT only; add ${license}'s canonical text as LICENSE by hand`);
				options.license = license;
				break;
			}
			default:
				if (argument.startsWith("-")) throw new UsageError(`unknown option ${argument}`);
				dir = argument;
		}
	}
	if (command === "audit") {
		const report = audit(dir, options);
		if (json) console.log(JSON.stringify(report, (key, value) => (key === "action" ? undefined : value), 2));
		else print(report);
		return 0;
	}
	const result = apply(dir, options);
	if (json) console.log(JSON.stringify({ ...result }, (key, value) => (key === "action" ? undefined : value), 2));
	else {
		console.log(`created: ${result.created.length > 0 ? result.created.join(", ") : "nothing"}`);
		if (result.skipped.length > 0) console.log(`skipped: ${result.skipped.join(", ")}`);
		print(result.report);
	}
	return 0;
}

class UsageError extends Error {}

if (import.meta.main) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`repo-baseline: ${message}`);
		process.exit(error instanceof UsageError ? 2 : 1);
	}
}
