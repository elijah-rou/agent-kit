#!/usr/bin/env bun
// agent-kit is standalone (rules.toml, standalone-kit). This check holds only the literal patterns in RULE and
// enforces each one fully; everything else the rule covers is held by review under that row.
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RULE =
	"agent-kit is standalone. Outside docs/analysis/, plans/, *-LICENSE, PROVENANCE, and provenance.toml (and this check and its test), this check refuses the word 'bootstrap' as a project name (not 'bootstrapping'), the word 'dotfiles', the literal ~/Projects, $HOME/Projects, or ${HOME}/Projects, and elijah-rou/<repo> for any repository other than agent-kit. Everything else the standalone rule covers is the review rule 'standalone-kit' in rules.toml. Say 'the installed kit' or 'an install', and keep installer-specific steps in the installer's own repository";

const FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
	// The project name and its environment variables; the verb's other forms ("bootstrapping") stay allowed.
	{ pattern: /\bbootstrap(?![a-z])/i, what: "the installer 'bootstrap' (for the verb, write 'bootstrapping' or rephrase)" },
	{ pattern: /dotfiles/i, what: "the user's dotfiles" },
	{ pattern: /(?:~|\$\{?HOME\}?)\/Projects\b/, what: "a machine-specific checkout path under the home directory's Projects" },
	// The owner's account, except agent-kit itself (optionally with .git); a repository name runs on word characters,
	// dots, and hyphens, so a following "." ends it only when no word character follows.
	{ pattern: /\belijah-rou\/(?!agent-kit(?:\.git)?(?![\w-]|\.\w))[\w.-]+/i, what: "another repository of the owner's GitHub account" },
];

// The exempt paths RULE names, plus this check and its test, which must name the patterns.
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
