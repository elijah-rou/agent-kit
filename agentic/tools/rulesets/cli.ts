#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { desiredRuleset, ruleDiff, RULESET_NAME, settingsDiff, splitChecks, verified, type Rule, type Tier } from "./rulesets.ts";

const USAGE = `Usage: rulesets <plan | apply> <owner/repo> [--tier baseline|merge-gate]

Keep the "${RULESET_NAME}" GitHub ruleset on a repository's default branch: the server-side
backstop for agents. It has no bypass actors, because agents use your token.

  baseline    (default) no deletion, no force-push, linear history. No friction for direct pushes.
  merge-gate  baseline plus a pull request, the agentic/verdict check (agentic verify), and the
              CI checks that passed on the default branch head. Everyone then lands through pull
              requests; use it where a repository lands verified stacks (the ship mode).

plan   Read-only. Prints the repository, the desired ruleset, and what apply would change.
apply  Creates or updates the ruleset (it changes remote settings, so it needs the user's
       authorization), then reads back the default branch's active rules to verify.

Private repositories need GitHub Pro (or Team) for rulesets; plan reports that as unavailable.

Exit status: 0 done or nothing to change, 1 failure or verification mismatch, 2 usage error,
3 rulesets unavailable for this repository.
`;

function gh(args: string[], input?: string): { ok: boolean; status: number; json: unknown; text: string } {
	const result = spawnSync("gh", ["api", ...args], { input, encoding: "utf8" });
	const text = (result.stdout || result.stderr || "").trim();
	let json: unknown;
	try {
		json = JSON.parse(result.stdout);
	} catch {
		json = undefined;
	}
	const status = Number(/HTTP (\d{3})/.exec(result.stderr ?? "")?.[1] ?? (result.status === 0 ? 200 : 0));
	return { ok: result.status === 0, status, json, text };
}

function fail(message: string, code = 1): never {
	console.error(`rulesets: ${message}`);
	process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.length < 2) {
	console.log(USAGE);
	process.exit(args.includes("--help") ? 0 : 2);
}
const [command, repo] = args;
const tierIndex = args.indexOf("--tier");
const tier = (tierIndex === -1 ? "baseline" : args[tierIndex + 1]) as Tier;
if (!["plan", "apply"].includes(command) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !["baseline", "merge-gate"].includes(tier)) {
	console.error(USAGE);
	process.exit(2);
}

const info = gh([`repos/${repo}`]);
if (!info.ok) fail(`cannot read ${repo}: ${info.text}`);
const { default_branch: branch, visibility } = info.json as { default_branch: string; visibility: string };

const listed = gh([`repos/${repo}/rulesets`]);
if (!listed.ok && listed.status === 403) {
	console.log(`${repo} (${visibility}, default branch ${branch}): rulesets unavailable on this plan; needs GitHub Pro or a public repository.`);
	process.exit(3);
}
if (!listed.ok) fail(`cannot list rulesets: ${listed.text}`);
const existing = (listed.json as { id: number; name: string }[]).find((ruleset) => ruleset.name === RULESET_NAME);
type Existing = Parameters<typeof settingsDiff>[0] & { rules?: Rule[] };
const detail = existing ? gh([`repos/${repo}/rulesets/${existing.id}`]) : undefined;
if (detail && !detail.ok) fail(`cannot read ruleset ${existing!.id}: ${detail.text}`);
const existingRuleset = detail?.json as Existing | undefined;
const current: Rule[] = existingRuleset?.rules ?? [];

let checks: string[] = [];
if (tier === "merge-gate") {
	const runs = gh([`repos/${repo}/commits/${branch}/check-runs`, "--paginate", "--jq", ".check_runs[] | {name, conclusion}"]);
	const split = splitChecks(runs.text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { name: string; conclusion: string | null }));
	checks = split.passing;
	if (split.other.length > 0) console.log(`not required (did not pass on ${branch} head): ${split.other.join(", ")}`);
}

const desired = desiredRuleset(tier, checks);
const diff = ruleDiff(current, desired.rules);
const settings = existingRuleset ? settingsDiff(existingRuleset, desired) : [];
const changes = [...settings.map((setting) => `~${setting}`), ...diff.add.map((type) => `+${type}`), ...diff.change.map((type) => `~${type}`), ...diff.remove.map((type) => `-${type}`)];
console.log(`${repo} (${visibility}, default branch ${branch}), tier ${tier}: ${existing ? `ruleset ${existing.id}` : "no ruleset"}; ${changes.length ? `changes ${changes.join(" ")}` : "up to date"}`);
if (tier === "merge-gate") console.log(`required checks: ${checks.join(", ")}`);

if (command === "plan") process.exit(0);
if (changes.length === 0) process.exit(0);

const written = existing ? gh(["-X", "PUT", `repos/${repo}/rulesets/${existing.id}`, "--input", "-"], JSON.stringify(desired)) : gh(["-X", "POST", `repos/${repo}/rulesets`, "--input", "-"], JSON.stringify(desired));
if (!written.ok) fail(`could not write the ruleset: ${written.text}`);
const active = gh([`repos/${repo}/rules/branches/${branch}`]);
if (!active.ok || !verified(active.json as { type: string }[], desired.rules)) fail(`ruleset written, but ${branch}'s active rules do not include all of: ${desired.rules.map((rule) => rule.type).join(", ")}`);
console.log(`applied and verified on ${branch}: ${desired.rules.map((rule) => rule.type).join(", ")}`);
