# Augmentation versus cruft: the full agentic stack compared with pstack

Written 2026-10-07 on the reference branch `agent/reference-full-stack`. That branch keeps everything built while porting the agentic stack design into agent-kit. Agent-kit PR 1 was reworked to land only the augmentations below. This file records why, so any parked piece can come back when evidence calls for it.

## The question

Does the code help, and has it been shown to help? "Code" here means the TypeScript, not the Markdown.

## Footprint

pstack is about 12,000 lines: about 5,300 lines of skill text and 6,700 lines of code. Almost all of that code is two scripts, `orch` (the program store and verdict ledger) and `watch-pr` (PR polling). Everything else in pstack is convention the agent is trusted to follow.

This branch adds about 17,000 lines of TypeScript to agent-kit: about 12,400 lines of code and 4,600 lines of tests.

| Area | Code lines | What it is |
|---|---|---|
| `agentic/src` | 3,277 | The policy gate: shell parser and classifier, Cedar engine, facts, protected paths, Jev and redaction, CLI and hooks, learning cadence |
| `agentic/vendor/watch-pr` | 2,417 | pstack's PR watcher, verbatim |
| `agentic/tools` | 2,333 | decision-log, rule-table, upstream-drift, feature-map-lint, report-lint, rulesets, verify |
| `agentic/vendor/orch` | 2,183 | pstack's program store and verdict ledger, verbatim |
| `agentic/evals` | 1,854 | The blinded skill eval harness and its fixture projects |
| `pi/extensions` | 355 | The question contract, focus and digest, report lint |

## Evidence per piece of TypeScript

**Shown to help:**
- `upstream-drift`: its one run found real upstream changes and led to two reviewed resyncs.
- `rulesets`: it put the server-side backstop on four repositories, and repeats it for new ones.
- The evals harness, as an instrument: it showed that the git-workflow skill changes behavior and that the verification and planning guidance show no measurable effect. It is research tooling, not something agents use.

**Works, but nothing has depended on it:**
- `verify` with `orch`: verdicts were recorded, voided by a head rewrite, and re-recorded on bootstrap PR 7, but no repository is at A3 or A4.
- The Pi interaction extensions: they work live in the TUI, but their value is unmeasured.
- `feature-map-lint` and `report-lint`: they caught nothing real.
- `decision-log` and the learning code: not enabled in real use.

**Never run:** the vendored `watch-pr`.

**Not shown to help, with observed cost:** the policy gate in `agentic/src`.
- It caught no mistake an agent actually made in real work. Its supporting evidence is counterfactual (the prototype's s1 and s12 runs, the 2026-10-03 branch-deletion loop) or staged demos.
- Its cost was observed:
  - three review rounds spent chasing bypasses;
  - false positives that blocked the coordinator and its children (`cd` into the gate's own directory, `bun test agentic`, heredoc commits, repository scripts, `rm -rf` of a temp directory);
  - a silent hole in which bypass-permission sessions auto-approved its asks;
  - test pollution of the user's real configuration directory.
- About 1,250 of its lines try to understand arbitrary shell, a job with no natural end.
- The 40-line `git-interceptor.ts` it replaced guarded child publication, `--no-verify`, and editor hangs, with no recorded friction.

## Augmentations (kept in the rework)

- **GitHub rulesets and the `github-rulesets` skill:** pstack defers to the forge but does not set it up. This is now a real backstop on four repositories.
- **Real verification skills in the product repositories** (verify-bootstrap, verify-interview-tutor): pstack ships the creator skill; these are working instances, and they found real bugs.
- **The catalog-bumps outer loop in bootstrap:** it produced two real PRs and caught a `scripts/pin` bug.
- **upstream-drift and provenance:** needed because pstack is adapted, not forked.
- **The autonomy ladder, the interaction contract, and the reviewed learning path, as instruction text.** They are cheap, and clearer than pstack's stance plus per-run overrides for a multi-repository setup.
- **Adapted skills that the instructions name or that were actually used:** correct, reflect, teach, design-checkpoint, prototype-to-decide, create-verification, maintain-verification, plus the skill resyncs.

## Cruft (parked on this branch)

- **The policy gate.** Cedar, the classifier, protected paths, the `enforcement` kind, `cd` tracking, copy landing, checkout-rewrite detection, Jev on the hot path, and the Claude hook. Most of its hardening came from reviewers constructing bypasses, not from mistakes agents made.
- **`verify`, the verdict policies, and push records.** Enforcement added around pstack's convention (a coordinator records a fresh verifier's verdict in `orch`) before any repository reached A3.
- **`decision-log`, `rule-table`, `feature-map-lint`, and `report-lint`.** Tooling around prose conventions, with almost no catches.
- **Pi enforcement of the interaction contract, the `claude-stop` hook, and the learning code.** Unmeasured or unexercised; the text form may be enough.
- **The vendored `orch` and `watch-pr`.** pstack's own code, but premature here.
- **Skills not yet exercised that depend on parked tooling:** babysit-and-ship, background-run, show-me-your-work.
- **The evals harness.** Kept here as an instrument; it does not belong in agent-kit.

## When to bring a piece back

Use the D2 evidence rule. A parked piece returns when a real session shows the mistake it prevents, routed through `correct`. The orch and verdict path returns when a repository is promoted to A3. watch-pr returns when agents routinely shepherd PRs to green. A gate returns at interceptor scale first: a small pattern check for messages to people, merges, deploys and releases, grants-file writes, and child publication, with logging, so its catches can be counted before it grows.

## Lesson

Enforcement and tooling were built for the design's whole picture before any of it earned its place. That is what Lauren Tan's correction ladder and this design's own evidence rule say not to do.
