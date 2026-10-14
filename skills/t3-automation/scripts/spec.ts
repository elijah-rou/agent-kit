#!/usr/bin/env bun
// t3-automation: render the exact title, prompt, and schedule of a known T3 scheduled automation, so the stored
// contract lives in code and tests. It only reads git; creating the schedule is the agent's call to T3's
// schedule_task with this output. A schedule outlives a revert of this file or a rollback of the kit's pin, so the
// prompt carries a version marker and tells each run to stop when its instructions no longer recognize it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const USAGE = `Usage: spec.ts upkeep --skill <dir> [--checkout <path>]

Print one JSON object describing a T3 scheduled automation: {kind, version, title, prompt, schedule,
bindToCurrentThread, repo}. Pass title, prompt, schedule, and bindToCurrentThread to schedule_task unchanged.

  upkeep            The weekly maintain-verification upkeep of one verification skill.
  --skill <dir>     The skill's repository-relative directory, .agents/skills/verify-<app>.
  --checkout <path> Any checkout of the repository; the prompt names its main checkout. Default: the current directory.

The repository is origin's GitHub owner/repo (https or ssh), and the trunk is origin's HEAD. The skill must be on
origin's trunk, and the maintain-verification skill installed beside this one must have a "## Scheduled runs"
section naming this version's marker.

Exit status: 0 printed, 1 a git read or precondition failed, 2 usage error.
`;

export const VERSION = 1;
export const UPKEEP_MARKER = `[t3-automation upkeep v${VERSION}]`;
// maintain-verification must keep this heading, and list UPKEEP_MARKER inside its section, for stored prompts to run.
export const SCHEDULED_RUNS_HEADING = "## Scheduled runs";
export const UPKEEP_BRANCH_PREFIX = "agent/verify-upkeep-";
export const UPKEEP_TITLE_PREFIX = "Weekly verification upkeep: ";
// Runs start on a weekday between 04:00 and 06:55 local time, in five-minute slots, picked from the title's hash.
export const UPKEEP_WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const UPKEEP_WINDOW = { startMinute: 4 * 60, slots: 36, slotMinutes: 5 } as const;

const SKILL_DIR = /^\.agents\/skills\/(verify-([a-z0-9]+(?:-[a-z0-9]+)*))$/;
const GITHUB_NAME = "([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/([A-Za-z0-9._-]+?)(?:\\.git)?/?";
const ORIGIN_FORMS = [new RegExp(`^https://github\\.com/${GITHUB_NAME}$`), new RegExp(`^git@github\\.com:${GITHUB_NAME}$`), new RegExp(`^ssh://git@github\\.com/${GITHUB_NAME}$`)];

// Whether maintain-verification's text has the Scheduled runs section and that section names this version's marker.
// A stored prompt runs only when this holds for the installed instructions, and the spec renders only when it holds.
export function recognizesUpkeep(instructions: string): boolean {
	const lines = instructions.split("\n");
	const start = lines.indexOf(SCHEDULED_RUNS_HEADING);
	if (start < 0) return false;
	const end = lines.findIndex((line, at) => at > start && /^#{1,2} /.test(line));
	return lines.slice(start + 1, end < 0 ? undefined : end).some(line => line.includes(UPKEEP_MARKER));
}

export class UsageError extends Error {}
export class Failure extends Error {}

export interface FixedTime {
	type: "fixed_time";
	timeOfDay: string;
	weekdays: number[];
}
export interface Spec {
	kind: "upkeep";
	version: number;
	title: string;
	prompt: string;
	schedule: FixedTime;
	bindToCurrentThread: true;
	repo: string;
}
export interface UpkeepInput {
	repo: string;
	trunk: string;
	checkout: string;
	skill: string;
	instructions: string;
}

// owner/repo from a GitHub origin URL, or null for any other form. URLs carrying credentials are not GitHub forms
// here, so a token never reaches a stored prompt.
export function parseOrigin(url: string): string | null {
	for (const form of ORIGIN_FORMS) {
		const match = form.exec(url);
		if (match && match[2] !== "." && match[2] !== "..") return `${match[1]}/${match[2]}`;
	}
	return null;
}

export function parseSkill(dir: string): { path: string; name: string; app: string } {
	const match = SKILL_DIR.exec(dir.replace(/\/$/, ""));
	if (!match) throw new UsageError(`--skill must be a repository-relative .agents/skills/verify-<app> directory, got "${dir}"`);
	return { path: match[0], name: match[1]!, app: match[2]! };
}

export const upkeepTitle = (repo: string, skillName: string) => `${UPKEEP_TITLE_PREFIX}${repo} ${skillName}`;

export function upkeepSchedule(title: string): FixedTime {
	const hash = createHash("sha256").update(title).digest().readUInt32BE(0);
	const weekday = UPKEEP_WEEKDAYS[hash % UPKEEP_WEEKDAYS.length]!;
	const slot = Math.floor(hash / UPKEEP_WEEKDAYS.length) % UPKEEP_WINDOW.slots;
	const minute = UPKEEP_WINDOW.startMinute + slot * UPKEEP_WINDOW.slotMinutes;
	const timeOfDay = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
	return { type: "fixed_time", timeOfDay, weekdays: [weekday] };
}

export function upkeepPrompt(input: UpkeepInput, title: string): string {
	const { repo, trunk, checkout, skill, instructions } = input;
	const { app } = parseSkill(skill);
	return [
		`${UPKEEP_MARKER} Weekly verification upkeep of ${skill} in ${repo}, for schedule "${title}".`,
		`Read the maintain-verification instructions from ${instructions} now, even if an earlier copy is already in this thread. If that file is missing, has no "${SCHEDULED_RUNS_HEADING}" section, or that section does not contain the marker ${UPKEEP_MARKER}, change nothing and reply only: Schedule "${title}" is obsolete and should be disabled (update_scheduled_task with enabled false, or switch it off in the schedule list).`,
		`Otherwise follow that Scheduled runs section for repository ${repo}, main checkout ${checkout}, trunk origin/${trunk}, and skill ${skill}.`,
		`In every case: pass -R ${repo} to every gh command; never check out, edit, or commit in ${checkout}, and work only in a separate worktree off origin/${trunk}; open at most one upkeep pull request, from a branch named ${UPKEEP_BRANCH_PREFIX}${app}-<YYYY-MM-DD> in ${repo}; never merge; ask the user nothing; and on any permission prompt, guard, or refusal, end blocked, naming the action.`,
	].join("\n\n");
}

export function renderUpkeep(input: UpkeepInput): Spec {
	const { name } = parseSkill(input.skill);
	if (parseOrigin(`https://github.com/${input.repo}`) !== input.repo) throw new UsageError(`not a GitHub owner/repo: ${input.repo}`);
	for (const [label, value] of [["checkout", input.checkout], ["instructions", input.instructions], ["trunk", input.trunk]] as const) {
		if (/[\x00-\x1f\x7f]/.test(value) || value.length === 0) throw new Failure(`${label} path is empty or holds a control character`);
	}
	const title = upkeepTitle(input.repo, name);
	return { kind: "upkeep", version: VERSION, title, prompt: upkeepPrompt(input, title), schedule: upkeepSchedule(title), bindToCurrentThread: true, repo: input.repo };
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.error) throw new Failure(`git could not run: ${result.error.message}`);
	return { ok: result.status === 0, out: result.stdout.trim() };
}

// Reads git to fill in the upkeep input; every read that fails stops with the command to run instead.
export function resolveUpkeep(skillArg: string, checkoutArg: string, instructions: string): UpkeepInput {
	const skill = parseSkill(skillArg).path;
	const list = git(checkoutArg, ["worktree", "list", "--porcelain"]);
	const main = /^worktree (.+)$/m.exec(list.out)?.[1];
	if (!list.ok || !main) throw new Failure(`${checkoutArg} is not a git checkout`);
	if (/^bare$/m.test(list.out.split("\n\n")[0]!)) throw new Failure(`${main} is a bare repository; pass a repository whose main checkout has a working tree`);
	const origin = git(main, ["remote", "get-url", "origin"]);
	const repo = origin.ok ? parseOrigin(origin.out) : null;
	// The URL is not echoed: it may carry a token.
	if (!repo) throw new UsageError("origin must be a GitHub https or ssh URL (https://github.com/<owner>/<repo>, git@github.com:<owner>/<repo>, or ssh://git@github.com/<owner>/<repo>)");
	const head = git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (!head.ok || !head.out.startsWith("origin/")) throw new Failure("origin's HEAD is unknown; run git remote set-head origin --auto");
	const trunk = head.out.slice("origin/".length);
	if (!git(main, ["cat-file", "-e", `origin/${trunk}:${skill}/SKILL.md`]).ok) throw new Failure(`${skill}/SKILL.md is not on origin/${trunk}; schedule upkeep once it lands`);
	if (!existsSync(instructions)) throw new Failure(`maintain-verification is not installed beside this skill: ${instructions}`);
	if (!recognizesUpkeep(readFileSync(instructions, "utf8"))) throw new Failure(`${instructions} has no "${SCHEDULED_RUNS_HEADING}" section naming ${UPKEEP_MARKER}; a schedule created now would only report itself obsolete`);
	return { repo, trunk, checkout: main, skill, instructions };
}

function parseArgs(argv: string[]): { skill: string; checkout: string } {
	const [kind, ...rest] = argv;
	if (kind !== "upkeep") throw new UsageError(kind === undefined ? "missing kind" : `unknown kind: ${kind}`);
	const options: Record<string, string> = {};
	for (let at = 0; at < rest.length; at += 2) {
		const flag = rest[at]!;
		const value = rest[at + 1];
		if (flag !== "--skill" && flag !== "--checkout") throw new UsageError(`unknown option: ${flag}`);
		if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
		if (flag in options) throw new UsageError(`${flag} given twice`);
		options[flag] = value;
	}
	if (options["--skill"] === undefined) throw new UsageError("--skill is required");
	return { skill: options["--skill"], checkout: options["--checkout"] ?? process.cwd() };
}

export function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	try {
		const { skill, checkout } = parseArgs(argv);
		const instructions = join(realpathSync(join(import.meta.dir, "..", "..")), "maintain-verification", "SKILL.md");
		process.stdout.write(`${JSON.stringify(renderUpkeep(resolveUpkeep(skill, checkout, instructions)), null, 2)}\n`);
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`spec.ts: ${error.message}\n\n${USAGE}`);
			return 2;
		}
		if (error instanceof Failure) {
			process.stderr.write(`spec.ts: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
