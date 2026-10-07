# Blinded skill evals (R15, design D11)

**Outcome:** the git-workflow eval separates the real skill from a weakened copy. The verification eval does not, because on this model both copies already write a failing test first. The harness, blinding checker and grading code are in this directory, with one line per run in [`results.jsonl`](results.jsonl).

## Method

- **Subjects:** the user's agent-kit `verification` and `git-workflow` skills, copied read-only into `subjects/<name>/current/`. Each has a deliberately weakened copy in `subjects/<name>/weakened/`:
  - verification loses the reproduce-before-fix and parent-acceptance rules;
  - git-workflow loses "one concern per commit" and "the commit body explains why".
- **Blinding** (`blinding.ts`, unit-tested). Text is split into whole words, so "attest" doesn't trip "test".
  - **Meta words** (eval, judge, rubric, score, candidate, compare, variant, sandbox, and their forms) are rejected anywhere a candidate can look: the prompt, paths, fixtures, the skill text, the environment, and the system prompt Pi actually sent (read back from each transcript).
  - **Harness words** (test, fixture, scenario) are rejected only in text the harness writes, so real code and real skills may say "test", but the prompt can't hint at test-first.
  - **Directory names** are realistic kebab-case project names.
- **Isolation.** Candidates run in a fresh temporary directory with a sanitized `HOME` and an allowlisted environment. Inside the worktree, Pi would have written a path containing the word "evals" into the system prompt.
- **Scenarios.** Four small projects, each with a request phrased as a user would type it, and a held-out check that passes on a reference fix and fails on the original:
  - verification: `split-cents` (Python), `ride-duration` (TypeScript);
  - git-workflow: `ledger-two-changes` (TypeScript), `pantry-two-changes` (Python).
- **Rubric.** Five criteria per subject, fixed in advance in `scenarios.ts`. Criteria are deterministic wherever possible, decided from event order, test reruns, and `git log`. Judgment criteria go to a judge model that sees outputs only under shuffled labels.
- **Acceptance rule, fixed in advance:** the current skill's mean ≥ 0.7, the weakened copy's mean < 0.7, and a margin of at least 0.2.
- **Runs:**
  - 16 candidate runs on `openai-codex/gpt-6-astra` at medium thinking (4 scenarios × 2 copies × 2), costing about $2.95;
  - 4 judge runs on `openai-codex/gpt-6.1-sol`.

## Results

| Subject | Current | Weakened | Margin | Acceptance |
|---|---|---|---|---|
| verification | 1.0, 1.0, 1.0, 1.0 | 1.0, 1.0, 1.0, 1.0 | 0 | Not met |
| git-workflow | 1.0, 1.0, 0.8, 0.8 (mean 0.90) | 0.4, 0.4, 0.4, 0.4 | 0.50 | Met |

- **git-workflow, weakened copy:** each run made one commit covering both changes, with an empty body.
- **git-workflow, current copy:** two focused commits per run, with bodies giving reasons. The two 0.8 scores are a defect in the pre-registered check: the pantry runs split the work correctly but touched files the path mapping didn't cover. The score was kept as registered; the corrected mean is 1.0.
- **verification, weakened copy:** it still reproduced the bug first (for example `runs/split-cents.weakened.1/transcript.jsonl`, a failing test run at event 40 before the source edit at event 46). This model already does test-first unprompted, so removing the rule changed nothing measurable here. That's a finding about the eval's sensitivity on a strong model, not evidence that the rule is useless.

## Limits

- **Same-family judge.** The Codex subscription exposes only OpenAI models, so the judge shares the candidates' model family. That doesn't meet D11's different-family requirement.
- **Small sample:** two runs per copy per scenario, on one candidate model.
- **Heuristic edit detection** for shell-made edits; edits through the edit and write tools are tracked exactly.

## Next steps

1. **Verification:** add scenarios where test-first is costly or not the obvious move (no existing tests, a bug reproducible only through the CLI, a request pushing for a quick fix), plus a parent and child scenario to exercise parent acceptance. Repeat on a cheaper model, where the skill has more to add.
2. **git-workflow:** replace the file-path mapping with a per-commit behavior check: at each commit, exactly one held-out check should flip from failing to passing.
3. **Judge:** use one from another model family once one is available.
