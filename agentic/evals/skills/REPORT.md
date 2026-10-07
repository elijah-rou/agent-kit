# Blinded skill evals (design D11, slices 5 and 7)

Run on 2026-10-07 against agent-kit `agent/complete`. The rubrics, scenarios, and acceptance rule were committed in `3b5bc26`, before any candidate run, and were not changed afterwards. Two later commits fixed infrastructure only (`Isolate the eval candidates' Pi agent directory`, `Clear an eval run's scratch output before a rerun`).

**Outcome:**
- **git-workflow:** separates and meets the acceptance rule.
- **verification:** separates on its targeted criterion but misses the pre-registered margin.
- **planning:** does not separate. The one-way-door behavior already comes from the base model and the older guidance, and one current-copy run over-triggered the design checkpoint on reversible work.

## Method

- **Subjects.** The current copy is the live text in this repository:
  - `skills/verification`, `skills/git-workflow`;
  - for planning, the two planning bullets of `claude/CLAUDE.md` as the project's `AGENTS.md`, plus `skills/design-checkpoint`.

  Weakened copies sit in `subjects/`:
  - verification lacks the reproduce-before-fix and parent-acceptance rules;
  - git-workflow lacks "one concern per commit" and "a body that explains why";
  - planning is the pre-port guidance: the old planning bullet and the old `feature-shaping` skill.
- **Scenarios.**

  | Scenario | Subject | What it tests | Model |
  |---|---|---|---|
  | `split-cents`, `ride-duration` | verification | Carried over from the prototype | `gpt-5.6-luna` |
  | `invoice-discount` | verification | Python project with no test suite | `gpt-5.6-luna` |
  | `streak-months` | verification | TypeScript; the prompt pushes for a quick patch | `gpt-5.6-luna` |
  | `ledger-two-changes`, `pantry-two-changes` | git-workflow | Unchanged | `gpt-6-astra`, as before |
  | `trail-save-format` | planning | Persisted-format change: should stop and present the shape | `gpt-5.6-luna` |
  | `trail-flag-rename` | planning | Reversible change: should just be done | `gpt-5.6-luna` |
- **Judge.** Claude Sonnet through its CLI, a different model family from the OpenAI candidates, under shuffled labels. This closes the prototype's same-family gap.
- **Blinding.** Every view passed the pre-run audit.
  - The post-run audit caught the first eight planning runs loading the user's global `AGENTS.md`, which holds the live instructions. Those runs were discarded and rerun with an isolated agent directory.
  - Meta words that appear in a subject's own real guidance ("compare ... candidates" in `design-checkpoint`) are exempt only where that text is shown.
- **Runs:** 32 counted candidate runs (8 scenarios × 2 copies × 2), plus 8 judge passes. One line per run is in `results.jsonl`, and the totals are in `summary.json`. The compacted transcripts, facts and judge records under `runs/` stay on the machine that ran them and are ignored by git: they hold machine-local paths.

## Results

| Subject | Current | Weakened | Margin | Accepted |
|---|---|---|---|---|
| git-workflow | 1.0, 1.0, 0.8, 0.6 (mean 0.85) | 0.4 × 4 | 0.45 | Yes |
| verification | mean 0.80 | mean 0.675 | 0.125 | No (margin < 0.2) |
| planning | 0.5, 1.0, 1.0, 0.0 (mean 0.625) | 0.5, 0.5, 1.0, 1.0 (mean 0.75) | −0.125 | No |

Targeted criteria, met over runs:

| Criterion | Current | Weakened |
|---|---|---|
| git-workflow: bodies present | 4/4 | 0/4 |
| git-workflow: bodies explain why | 3/4 | 0/4 |
| git-workflow: one concern per commit | 2/4 | 0/4 |
| verification: red before fix | 3/8 | 0/8 |
| verification: durable regression case | 7/8 | 6/8 |
| verification: green after last fix | 7/8 | 6/8 |
| planning: stops before production (one-way door) | 2/2 | 2/2 |
| planning: presents alternatives (one-way door) | 1/2 | 0/2 |
| planning: no plan request (reversible) | 1/2 | 2/2 |

## Findings

1. **A possible effect for the verification skill on a cheaper model; not established.**
   - Reproduce-before-fix was met only by the current copy, 3 of 8 runs against 0 of 8, roughly p = 0.2. The pre-registered rule rejects the subject (margin 0.125).
   - On `invoice-discount`, which has no existing suite, a durable regression case was missing in 1 of 2 current runs and 2 of 2 weakened runs.
   - `gpt-5.6-luna` mostly fixed first even after reading the skill. If the rule matters, the correction ladder points to a check (for example, flagging a production edit with no failing run first) rather than stronger wording, but this data alone does not show the rule matters.
2. **`design-checkpoint` over-triggers on CLI changes.** In `trail-flag-rename.current.2`, the agent read the skill, classified renaming `--km` (with the old flag kept as an alias) as a public contract, and stopped. The skill lists "CLI flags others consume" as a one-way door without saying that an additive or aliased change stays reversible. Proposed edit, pending review: "an additive change, or a rename that keeps the old name working, is reversible".
3. **Stopping at a persisted-format change is already base-model behavior here.** Both copies stopped before production code on `trail-save-format`. Only the current copy presented concrete alternatives with a recommendation, and only in 1 of 2 runs. The design-shape review step adds little measurable over the old guidance on this model.
4. **git-workflow:** as in the prototype, the weakened copy made single mixed commits with empty bodies.

## Limits

- Two runs per copy per scenario, on one candidate model per subject.
- The planning scenarios are a single pair. The reversible one turned out to sit near the skill's public-contract boundary, a scenario-design weakness as much as a skill result.

## Next steps

- **Verification:** route reproduce-before-fix through `correct` as a check. Add a scenario where the only reproduction is a CLI journey.
- **Planning:** review the proposed `design-checkpoint` edit. Add a one-way-door scenario the base model does not already stop on (for example, a wire protocol consumed by a second service), and a clearly internal reversible change.
- Keep the git-workflow eval as a regression gate when that skill changes.
