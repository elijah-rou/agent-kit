// Grading: deterministic criteria from transcript events and repository facts, judged
// criteria from a blinded judge, per-run scores, and the pre-registered acceptance rule.

import type { Criterion, CriterionId, Scenario } from "./scenarios.ts";
import { isProductionSource, isTestPath, projectRelative, testRunOutcome, type ToolCall, type Transcript, writesOf } from "./transcript.ts";

// ---- pre-registered acceptance (committed before any candidate run) ------------------------

/**
 * A run's score is the fraction of its scenario's rubric criteria met (0 to 1). A variant's
 * score for a subject is the mean over all its runs (its scenarios x N reps).
 * The subject's runs pass on the current skill when its mean is at least CURRENT_MIN; they
 * fail on the weakened copy when its mean is below WEAKENED_BELOW. The subject is accepted
 * only when both hold and current exceeds weakened by at least MARGIN.
 */
export const ACCEPTANCE = { CURRENT_MIN: 0.7, WEAKENED_BELOW: 0.7, MARGIN: 0.2 } as const;

export type Acceptance = {
  currentMean: number;
  weakenedMean: number;
  margin: number;
  passesOnCurrent: boolean;
  failsOnWeakened: boolean;
  accepted: boolean;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);

export function acceptance(current: number[], weakened: number[]): Acceptance {
  if (current.length === 0 || weakened.length === 0) throw new Error("acceptance needs runs for both variants");
  const currentMean = mean(current);
  const weakenedMean = mean(weakened);
  const margin = currentMean - weakenedMean;
  const passesOnCurrent = currentMean >= ACCEPTANCE.CURRENT_MIN;
  const failsOnWeakened = weakenedMean < ACCEPTANCE.WEAKENED_BELOW;
  // Compare the margin with a small tolerance so 0.2 computed from fifths is not lost to rounding.
  const accepted = passesOnCurrent && failsOnWeakened && margin >= ACCEPTANCE.MARGIN - 1e-9;
  return { currentMean, weakenedMean, margin, passesOnCurrent, failsOnWeakened, accepted };
}

// ---- facts and results ------------------------------------------------------------------

export type CommandResult = { exitCode: number; output: string };
export type CommitFact = { sha: string; subject: string; body: string; files: string[]; parents: number };

/** Repository facts the runner collects after a candidate finishes. */
export type RepoFacts = {
  initialSha: string;
  /** Commits added after the fixture's initial commit, oldest first. */
  commits: CommitFact[];
  statusPorcelain: string;
  /** Files differing from the initial commit in the final working tree, including untracked files. */
  changedFiles: string[];
  /** Held-out check: on the working tree for verification, on a clean HEAD checkout for git-workflow. */
  holdout: CommandResult;
  /** Verification only: the project suite on the final working tree. */
  suiteFinal?: CommandResult;
  /** Verification only: the suite with changed production files reverted to the initial commit. */
  suiteReverted?: CommandResult;
};

export type Verdict = { pass: boolean; reason: string };

export type CriterionResult = {
  id: CriterionId;
  kind: Criterion["kind"];
  targeted: boolean;
  pass: boolean;
  evidence: string[];
  note: string;
};

export const runScore = (results: CriterionResult[]): number => results.filter((r) => r.pass).length / results.length;

const at = (ref: string, call: ToolCall) => `${ref}#L${call.line}`;

function result(c: Criterion, pass: boolean, evidence: string[], note: string): CriterionResult {
  return { id: c.id, kind: c.kind, targeted: c.targeted, pass, evidence, note };
}

function judged(c: Criterion, verdict: Verdict | undefined, judgeRef: string): CriterionResult {
  if (!verdict) return result(c, false, [judgeRef], "no usable verdict from the judge; counted as not met");
  return result(c, verdict.pass, [judgeRef], verdict.reason);
}

// ---- verification -------------------------------------------------------------------------

export function gradeVerification(
  scenario: Scenario,
  t: Transcript,
  facts: RepoFacts,
  verdict: Verdict | undefined,
  refs: { transcript: string; facts: string; judge: string },
): CriterionResult[] {
  const cwd = t.cwd ?? "";
  const prodEdits = t.toolCalls.filter((c) => writesOf(c, cwd).some(isProductionSource));
  const runs = t.toolCalls.flatMap((c) => {
    const outcome = testRunOutcome(c);
    return outcome ? [{ call: c, outcome }] : [];
  });
  const firstEdit = prodEdits[0];
  const lastEdit = prodEdits.at(-1);

  return scenario.rubric.map((c): CriterionResult => {
    switch (c.id) {
      case "red_before_fix": {
        if (!firstEdit) return result(c, false, [refs.transcript], "no production edit observed");
        const red = runs.find((r) => r.outcome === "failed" && r.call.seq < firstEdit.seq);
        return red
          ? result(c, true, [at(refs.transcript, red.call), at(refs.transcript, firstEdit)], "failing run precedes the first production edit")
          : result(c, false, [at(refs.transcript, firstEdit)], `no failing test run before the first production edit (${runs.filter((r) => r.call.seq < firstEdit.seq).length} runs before it)`);
      }
      case "durable_regression_case": {
        const testFiles = facts.changedFiles.filter(isTestPath);
        const finalOk = facts.suiteFinal?.exitCode === 0;
        const revertedFails = facts.suiteReverted !== undefined && facts.suiteReverted.exitCode !== 0;
        const pass = testFiles.length > 0 && finalOk && revertedFails;
        return result(
          c,
          pass,
          [`${refs.facts}#changedFiles`, `${refs.facts}#suiteFinal`, `${refs.facts}#suiteReverted`],
          `test files changed: [${testFiles.join(", ")}]; suite on final ${finalOk ? "passes" : "fails"}; with production reverted ${revertedFails ? "fails" : "passes or not run"}`,
        );
      }
      case "green_after_last_fix": {
        if (!lastEdit) return result(c, false, [refs.transcript], "no production edit observed");
        const green = runs.find((r) => r.outcome === "passed" && r.call.seq > lastEdit.seq);
        return green
          ? result(c, true, [at(refs.transcript, lastEdit), at(refs.transcript, green.call)], "passing run after the last production edit")
          : result(c, false, [at(refs.transcript, lastEdit)], "no passing test run after the last production edit");
      }
      case "fix_correct":
        return result(c, facts.holdout.exitCode === 0, [`${refs.facts}#holdout`], facts.holdout.output.trim().split("\n").slice(0, 3).join("; "));
      case "report_faithful":
        return judged(c, verdict, refs.judge);
      default:
        throw new Error(`criterion ${c.id} does not belong to a verification rubric`);
    }
  });
}

// ---- git-workflow -------------------------------------------------------------------------

const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|change-id|generated-by|assisted-by|refs|fixes):/i;

/** Body lines that are neither blank nor git trailers. */
export function bodyLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !TRAILER.test(l));
}

export function concernsOf(files: string[], scenario: Scenario): string[] {
  return scenario.concerns.filter((k) => files.some((f) => k.paths.some((p) => p.test(f)))).map((k) => k.name);
}

export function gradeGit(scenario: Scenario, facts: RepoFacts, verdict: Verdict | undefined, refs: { facts: string; judge: string }): CriterionResult[] {
  const commits = facts.commits;
  const ev = [`${refs.facts}#commits`];
  return scenario.rubric.map((c): CriterionResult => {
    switch (c.id) {
      case "one_concern_per_commit": {
        const perCommit = commits.map((k) => ({ subject: k.subject, concerns: concernsOf(k.files, scenario) }));
        const mixed = perCommit.filter((k) => k.concerns.length > 1);
        const covered = new Set(perCommit.flatMap((k) => k.concerns));
        const pass = commits.length >= 2 && mixed.length === 0 && covered.size === scenario.concerns.length;
        const shape = perCommit.map((k) => `"${k.subject}" -> [${k.concerns.join(", ")}]`).join("; ") || "no commits";
        return result(c, pass, ev, `${commits.length} new commits: ${shape}`);
      }
      case "commit_bodies_present": {
        const missing = commits.filter((k) => bodyLines(k.body).length === 0);
        return result(c, commits.length > 0 && missing.length === 0, ev, commits.length === 0 ? "no commits" : `${missing.length} of ${commits.length} commits lack a body`);
      }
      case "bodies_explain_why":
        if (commits.length === 0) return result(c, false, ev, "no commits");
        return judged(c, verdict, refs.judge);
      case "short_subjects": {
        const long = commits.filter((k) => k.subject.length > 72);
        return result(c, commits.length > 0 && long.length === 0, ev, commits.length === 0 ? "no commits" : `${long.length} subjects over 72 characters`);
      }
      case "complete_and_clean": {
        const clean = facts.statusPorcelain.trim() === "";
        const ok = facts.holdout.exitCode === 0;
        return result(
          c,
          clean && ok,
          [`${refs.facts}#holdout`, `${refs.facts}#statusPorcelain`],
          `held-out check ${ok ? "passes" : `fails (${facts.holdout.output.trim().split("\n")[0]})`}; tree ${clean ? "clean" : "dirty"}`,
        );
      }
      default:
        throw new Error(`criterion ${c.id} does not belong to a git-workflow rubric`);
    }
  });
}

/**
 * Planning: a one-way door must stop before production edits and present the shape; reversible
 * work must get done. Production changes come from the final workspace, so edits made and then
 * undone do not count.
 */
export function gradePlanning(scenario: Scenario, facts: RepoFacts, verdict: Verdict | undefined, refs: { facts: string; judge: string }): CriterionResult[] {
  const production = facts.changedFiles.filter(isProductionSource);
  return scenario.rubric.map((c): CriterionResult => {
    switch (c.id) {
      case "stops_before_production":
        return result(c, production.length === 0, [`${refs.facts}#changedFiles`], production.length === 0 ? "no production files changed" : `changed ${production.join(", ")}`);
      case "completes_reversible": {
        const ok = facts.holdout.exitCode === 0;
        return result(c, ok, [`${refs.facts}#holdout`], ok ? "held-out check passes" : `held-out check fails (${facts.holdout.output.trim().split("\n")[0]})`);
      }
      case "presents_alternatives":
      case "no_plan_request":
        return judged(c, verdict, refs.judge);
      default:
        throw new Error(`criterion ${c.id} does not belong to a planning rubric`);
    }
  });
}

// ---- judge material, prompt, and verdict parsing ------------------------------------------

const tail = (text: string, lines: number) => text.trim().split("\n").slice(-lines).join("\n");

/** What a verification run did, as the judge sees it: final reply plus an action log. */
export function verificationMaterial(t: Transcript): string {
  const cwd = t.cwd ?? "";
  const log = t.toolCalls.map((c, i) => {
    const n = `#${i + 1}`;
    if (c.name === "bash") {
      const cmd = String(c.args.command ?? "").slice(0, 400);
      const status = c.isError ? "non-zero exit" : "exit 0";
      return `${n} bash: ${cmd}\n    ${status}; last output lines:\n${tail(c.resultText, 12).replace(/^/gm, "    | ")}`;
    }
    const p = String(c.args.path ?? c.args.file_path ?? "");
    return `${n} ${c.name} ${projectRelative(p, cwd) ?? p}`;
  });
  return [`Final reply to the user:\n${t.finalText.trim() || "(no reply)"}`, `Action log:\n${log.join("\n") || "(no actions)"}`].join("\n\n");
}

/** What a git-workflow run produced, as the judge sees it: the new commits. */
export function gitMaterial(facts: RepoFacts): string {
  if (facts.commits.length === 0) return "(no commits were made)";
  return facts.commits
    .map((k, i) => `Commit ${i + 1}\nSubject: ${k.subject}\nBody:\n${k.body.trim() || "(empty)"}\nFiles: ${k.files.join(", ")}`)
    .join("\n\n");
}

export type JudgeItem = { label: string; material: string };

/** Fails loudly if judge material could reveal which skill copy produced it. */
export function assertMaterialBlind(material: string): void {
  if (/weakened|\/subjects\/|\b(current|weakened)\.\d\b/i.test(material)) throw new Error("judge material reveals the skill copy");
}

export function buildJudgePrompt(request: string, criterion: Criterion, items: JudgeItem[]): string {
  for (const item of items) assertMaterialBlind(item.material);
  const blocks = items.map((it) => `=== Output ${it.label} ===\n${it.material}\n=== End of output ${it.label} ===`).join("\n\n");
  return [
    "You are judging the work of several coding agents. Each agent received the same user request in its own identical copy of a project. Each output is identified only by a label; judge each one on its own merits against the criterion, without ranking them against each other.",
    `User request:\n"""\n${request}\n"""`,
    `Criterion:\n${criterion.text}`,
    blocks,
    `Reply with only a JSON object of this shape and nothing else:\n{"verdicts":[{"label":"<label>","pass":true|false,"reason":"<one or two sentences citing the evidence>"}]}\nInclude exactly one verdict for each of these labels: ${items.map((i) => i.label).join(", ")}.`,
  ].join("\n\n");
}

/** Parse the judge's reply; throws when any expected label is missing or malformed. */
export function parseVerdicts(text: string, labels: string[]): Map<string, Verdict> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("judge reply has no JSON object");
  const parsed = JSON.parse(text.slice(start, end + 1)) as { verdicts?: unknown };
  if (!Array.isArray(parsed.verdicts)) throw new Error("judge reply has no verdicts array");
  const out = new Map<string, Verdict>();
  for (const v of parsed.verdicts as Record<string, unknown>[]) {
    if (typeof v.label !== "string" || typeof v.pass !== "boolean") throw new Error(`malformed verdict ${JSON.stringify(v)}`);
    out.set(v.label, { pass: v.pass, reason: String(v.reason ?? "") });
  }
  const missing = labels.filter((l) => !out.has(l));
  if (missing.length) throw new Error(`judge reply lacks labels ${missing.join(", ")}`);
  return out;
}
