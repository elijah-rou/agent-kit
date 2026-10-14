#!/usr/bin/env bun
// agent-kit is standalone: an installer installs it, and nothing here depends on or names the installer, another of
// the user's projects, or a machine-specific path. This check holds the parts a pattern can see (see RULE); naming
// another project in prose is held by review. Dated records and upstream attribution keep their history, so they are
// exempt.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RULE =
	"agent-kit is standalone. Outside dated records and upstream attribution, this check refuses the installer's name 'bootstrap', 'dotfiles', a 'Projects' checkout under the home directory (~/Projects, $HOME/Projects, or homedir() or Path.home() joined with \"Projects\" in code), a /Users/<name>/ or /home/<name>/ path, any .local/share path, and a GitHub reference to an elijah-rou repository other than agent-kit. Naming another of the user's projects in prose is held by review, not by this check. Say 'the installed kit' or 'an install', and keep installer-specific steps in the installer's own repository";

const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
	{ pattern: /\.local\/share\b/, what: "a machine-specific .local/share path" },
	// The project name and its environment variables; the verb's other forms ("bootstrapping") stay allowed.
	{ pattern: /\bbootstrap(?![a-z])/i, what: "the installer 'bootstrap' (for the verb, write 'bootstrapping' or rephrase)" },
	{ pattern: /dotfiles/i, what: "the user's dotfiles" },
	{
		pattern: /(?:~|\$\{?HOME\}?)\/Projects\b|homedir\(\)\s*,\s*["'`]Projects\b|Path\.home\(\)\s*\/\s*["']Projects\b/,
		what: "a machine-specific checkout path under the home directory's Projects",
	},
	{ pattern: /\/(?:Users|home)\/[\w.-]+\//, what: "a machine-specific home directory path" },
	// The owner's account, except agent-kit itself (optionally with .git); a repository name runs on word characters,
	// dots, and hyphens, so a following "." ends it only when no word character follows.
	{ pattern: /\belijah-rou\/(?!agent-kit(?:\.git)?(?![\w-]|\.\w))[\w.-]+/i, what: "another repository of the owner's GitHub account" },
];

// Dated records and attribution of adapted upstream content, plus this check and its test, which must name the rule.
const EXEMPT: readonly RegExp[] = [
	/^docs\/analysis\//,
	/^plans\//,
	/(?:^|\/)[^/]*-LICENSE$/,
	/(?:^|\/)PROVENANCE$/,
	/^provenance\.toml$/,
	/^scripts\/check-standalone(?:\.test)?\.ts$/,
];

// Exact phrases in the verification policy that pull request #56 rewords; a policy change lands only by countersign, so
// it lands separately. Once a phrase is gone, the check fails until its entry is removed here.
export const PENDING: readonly { path: string; phrase: string }[] = [
	{ path: ".agents/skills/verify-agent-kit/SKILL.md", phrase: "once bootstrap wires it" },
	{ path: ".agents/skills/verify-agent-kit/features/README.md", phrase: "(not yet wired by bootstrap)" },
];

export const isExempt = (path: string): boolean => EXEMPT.some(pattern => pattern.test(path));

// One message per offending line of a tracked file's text: `<path>:<line>: <what it names>`.
export function violations(path: string, text: string): string[] {
	if (isExempt(path) || text.includes("\0")) return [];
	const pending = PENDING.filter(entry => entry.path === path).map(entry => entry.phrase);
	const found: string[] = [];
	text.split("\n").forEach((line, at) => {
		const checked = pending.reduce((rest, phrase) => rest.replaceAll(phrase, ""), line);
		const hit = FORBIDDEN.find(({ pattern }) => pattern.test(checked));
		if (hit) found.push(`${path}:${at + 1}: names ${hit.what}`);
	});
	return found;
}

function trackedFiles(root: string): string[] {
	const result = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error(`git ls-files failed in ${root}: ${result.error?.message ?? result.stderr}`);
	return result.stdout.split("\0").filter(Boolean);
}

export function main(root: string): number {
	// A tracked symlink's content is its target path, which the files it points at are checked under.
	const found = trackedFiles(root)
		.filter(path => !lstatSync(join(root, path)).isSymbolicLink())
		.flatMap(path => violations(path, readFileSync(join(root, path), "utf8")));
	for (const { path, phrase } of PENDING) {
		if (!readFileSync(join(root, path), "utf8").includes(phrase)) found.push(`${path}: no longer holds "${phrase}"; remove its PENDING entry in scripts/check-standalone.ts`);
	}
	if (found.length === 0) return 0;
	process.stderr.write(`${found.join("\n")}\n\n${RULE}.\n`);
	return 1;
}

if (import.meta.main) process.exit(main(join(import.meta.dir, "..")));
