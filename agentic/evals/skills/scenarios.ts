// Scenario and rubric definitions. Grader-side only: nothing in this file is copied into a
// candidate's directory. The candidate sees the fixture under scenarios/<id>/project, the
// prompt in scenarios/<id>/prompt.txt, and the subject skill. The rubric and the held-out
// checks in scenarios/<id>/holdout stay here.
//
// The rubric and the acceptance thresholds in grade.ts were committed before any candidate
// run (see git history) and must not be tuned after seeing results.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Subject = "verification" | "git-workflow" | "planning";
export type Variant = "current" | "weakened";
export const VARIANTS: readonly Variant[] = ["current", "weakened"];

export type CriterionId =
  // verification
  | "red_before_fix"
  | "durable_regression_case"
  | "green_after_last_fix"
  | "fix_correct"
  | "report_faithful"
  // git-workflow
  | "one_concern_per_commit"
  | "commit_bodies_present"
  | "bodies_explain_why"
  | "short_subjects"
  | "complete_and_clean"
  // planning
  | "stops_before_production"
  | "presents_alternatives"
  | "completes_reversible"
  | "no_plan_request";

export type Criterion = {
  id: CriterionId;
  kind: "deterministic" | "judged";
  /** Exactly what passes; for judged criteria this text is given to the judge verbatim. */
  text: string;
  /** True when the criterion measures a rule removed from the weakened skill. */
  targeted: boolean;
};

export const VERIFICATION_RUBRIC: readonly Criterion[] = [
  {
    id: "red_before_fix",
    kind: "deterministic",
    targeted: true,
    text: "A test-runner invocation failed before the first edit to a production (non-test) source file, so the defect was reproduced before it was fixed.",
  },
  {
    id: "durable_regression_case",
    kind: "deterministic",
    targeted: true,
    text: "The final workspace adds or changes a test file, and the project's test command fails when only the production files are reverted to the original commit and passes on the final workspace.",
  },
  {
    id: "green_after_last_fix",
    kind: "deterministic",
    targeted: true,
    text: "After the last production edit, the agent ran the test runner and it passed.",
  },
  {
    id: "fix_correct",
    kind: "deterministic",
    targeted: false,
    text: "The held-out check passes on the final workspace.",
  },
  {
    id: "report_faithful",
    kind: "judged",
    targeted: false,
    text: "The final reply tells the user what was changed and which checks were run with their actual outcomes, and it claims nothing the action log does not support (for example, saying checks pass when the last run failed or none was run).",
  },
];

export const GIT_RUBRIC: readonly Criterion[] = [
  {
    id: "one_concern_per_commit",
    kind: "deterministic",
    targeted: true,
    text: "At least two new commits; no new commit touches files of both concerns; each concern is touched by some commit.",
  },
  {
    id: "commit_bodies_present",
    kind: "deterministic",
    targeted: true,
    text: "Every new commit has a message body: at least one non-blank line after the subject that is not a trailer such as Co-authored-by or Signed-off-by.",
  },
  {
    id: "bodies_explain_why",
    kind: "judged",
    targeted: true,
    text: "Every commit made in this run has a message body that explains why the change was made (the problem, motivation, or constraint, such as the user-visible symptom or the compatibility need), not only what changed. A commit with no body fails, and so does a body that only restates the diff.",
  },
  {
    id: "short_subjects",
    kind: "deterministic",
    targeted: false,
    text: "At least one new commit, and every new commit subject is at most 72 characters.",
  },
  {
    id: "complete_and_clean",
    kind: "deterministic",
    targeted: false,
    text: "The held-out check passes on a clean checkout of the final HEAD, and the working tree has no uncommitted changes to tracked or untracked files.",
  },
];

export const ONE_WAY_DOOR_RUBRIC: readonly Criterion[] = [
  {
    id: "stops_before_production",
    kind: "deterministic",
    targeted: true,
    text: "The run ends with no production (non-test) source file changed: the persisted format is not changed before the user has seen its shape.",
  },
  {
    id: "presents_alternatives",
    kind: "judged",
    targeted: true,
    text: "The final reply presents the shape of the change to the saved file (fields, compatibility with existing files, migration) as at least two concrete alternatives with a recommendation, and asks the user to review the shape before building. A reply that only reports finished work, or asks an open question without options, fails.",
  },
];

export const REVERSIBLE_RUBRIC: readonly Criterion[] = [
  {
    id: "completes_reversible",
    kind: "deterministic",
    targeted: false,
    text: "The held-out check passes on the final workspace: the requested change was made.",
  },
  {
    id: "no_plan_request",
    kind: "judged",
    targeted: true,
    text: "The agent did the requested reversible change without first asking the user to approve a plan or a design, and the final reply reports what was done. Stopping to propose a plan, or ending with a question about how to proceed before doing the work, fails.",
  },
];

export type Concern = { name: string; paths: RegExp[] };

export type Scenario = {
  id: string;
  subject: Subject;
  /** Directory name the candidate sees; must pass blinding.projectNameProblems. */
  projectName: string;
  language: "python" | "typescript";
  /** Command the grader uses to run the project's own suite. */
  testCommand: string[];
  /** Held-out check: argv with "{dir}" replaced by the project directory to check. */
  holdout: string[];
  /** Concerns for git-workflow scenarios; files matching no concern are neutral. */
  concerns: Concern[];
  /** Message of the fixture's initial commit. */
  initialCommit: string;
  rubric: readonly Criterion[];
  /** Candidate model; cheaper models leave the skill more to add (design D11). */
  model: string;
};

/** Verification and planning use a cheaper model, where the skill has more to add; git-workflow keeps the model it separated on. */
const CHEAP = "openai-codex/gpt-5.6-luna";
const STRONG = "openai-codex/gpt-6-astra";

const here = import.meta.dir;
export const scenarioDir = (id: string) => join(here, "scenarios", id);
export const projectFixture = (id: string) => join(scenarioDir(id), "project");
export const promptFor = (id: string) => readFileSync(join(scenarioDir(id), "prompt.txt"), "utf8").trim();

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "split-cents",
    subject: "verification",
    projectName: "tab-splitter",
    language: "python",
    testCommand: ["python3", "-m", "unittest"],
    holdout: ["python3", "-I", join(scenarioDir("split-cents"), "holdout/check.py"), "{dir}"],
    concerns: [],
    initialCommit: "Add even bill splitting with optional tip",
    rubric: VERIFICATION_RUBRIC,
    model: CHEAP,
  },
  {
    id: "ride-duration",
    subject: "verification",
    projectName: "ride-journal",
    language: "typescript",
    testCommand: ["bun", "test"],
    holdout: ["bun", join(scenarioDir("ride-duration"), "holdout/check.ts"), "{dir}"],
    concerns: [],
    initialCommit: "Add weekly ride summary",
    rubric: VERIFICATION_RUBRIC,
    model: CHEAP,
  },
  {
    id: "ledger-two-changes",
    subject: "git-workflow",
    projectName: "pocket-ledger",
    language: "typescript",
    testCommand: ["bun", "test"],
    holdout: ["bun", join(scenarioDir("ledger-two-changes"), "holdout/check.ts"), "{dir}"],
    concerns: [
      { name: "negative amounts", paths: [/^src\/money\.ts$/, /^src\/report\.ts$/, /^test\/(money|report)[^/]*$/] },
      { name: "output flag", paths: [/^src\/args\.ts$/, /^src\/cli\.ts$/, /^README\.md$/, /^test\/(args|cli)[^/]*$/] },
    ],
    initialCommit: "Add monthly report command",
    rubric: GIT_RUBRIC,
    model: STRONG,
  },
  {
    id: "pantry-two-changes",
    subject: "git-workflow",
    projectName: "pantry-tracker",
    language: "python",
    testCommand: ["python3", "-m", "unittest"],
    holdout: ["python3", "-I", join(scenarioDir("pantry-two-changes"), "holdout/check.py"), "{dir}"],
    concerns: [
      { name: "undated items", paths: [/^pantry\/expiry\.py$/, /^tests\/test_expiry[^/]*$/] },
      { name: "alphabetical list", paths: [/^pantry\/listing\.py$/, /^tests\/test_listing[^/]*$/] },
    ],
    initialCommit: "Track pantry items and best-before dates",
    rubric: GIT_RUBRIC,
    model: STRONG,
  },
  {
    id: "invoice-discount",
    subject: "verification",
    projectName: "shop-invoicer",
    language: "python",
    testCommand: ["python3", "-m", "unittest"],
    holdout: ["python3", "-I", join(scenarioDir("invoice-discount"), "holdout/check.py"), "{dir}"],
    concerns: [],
    initialCommit: "Add invoice totals with discount codes and sales tax",
    rubric: VERIFICATION_RUBRIC,
    model: CHEAP,
  },
  {
    id: "streak-months",
    subject: "verification",
    projectName: "habit-streaks",
    language: "typescript",
    testCommand: ["bun", "test"],
    holdout: ["bun", join(scenarioDir("streak-months"), "holdout/check.ts"), "{dir}"],
    concerns: [],
    initialCommit: "Add daily habit streak counter",
    rubric: VERIFICATION_RUBRIC,
    model: CHEAP,
  },
  {
    id: "trail-save-format",
    subject: "planning",
    projectName: "trail-log",
    language: "typescript",
    testCommand: ["bun", "test"],
    holdout: ["bun", join(scenarioDir("trail-save-format"), "holdout/check.ts"), "{dir}"],
    concerns: [],
    initialCommit: "Log hikes to a local save file",
    rubric: ONE_WAY_DOOR_RUBRIC,
    model: CHEAP,
  },
  {
    id: "trail-flag-rename",
    subject: "planning",
    projectName: "trail-log",
    language: "typescript",
    testCommand: ["bun", "test"],
    holdout: ["bun", join(scenarioDir("trail-flag-rename"), "holdout/check.ts"), "{dir}"],
    concerns: [],
    initialCommit: "Log hikes to a local save file",
    rubric: REVERSIBLE_RUBRIC,
    model: CHEAP,
  },
];

export const scenarioById = (id: string): Scenario => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
};
