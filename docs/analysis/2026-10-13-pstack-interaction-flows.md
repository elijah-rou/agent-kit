# Interaction flows: agent-kit compared with pstack

Written 2026-10-13. It compares how a user drives four kinds of work through pstack and through agent-kit, then lists what agent-kit lacks. pstack was read at cursor/plugins `1dcc2ba` (2026-10-12): `pstack/docs/guide/`, `pstack/skills/poteto-mode/SKILL.md`, and the playbooks it routes to. agent-kit was read at `5c9aeaf`. The flows for agent-kit apply to Pi and Claude Code; Codex is frozen and exports only the method skills (`codex/skills.txt`).

## The two interaction models

pstack has one front door. The user types `/poteto-mode`, ideally pinned as a Custom Mode so it stays in context, and states a goal, a done check, and the proof they want. The mode matches one of 23 playbooks and copies its steps into the todo list. Rigor is opt-in per chat; the guide says to save `/poteto-mode` for work that needs it.

agent-kit has no front door, by design: `skills/README.md` calls `poteto-mode` "a mode skill with no equivalent here". The method is always on through `claude/CLAUDE.md` and `pi/AGENTS.md`. The user states the outcome and what done means; the agent decides everything reversible and stops only at one-way doors (`design-checkpoint`), decisions that are the user's, and blockers. The user's levers are the manual skills (`create-verification`, `maintain-verification`, `babysit-and-ship`, `background-run`, `correct`, `reflect`) and the words that invoke a landing mode ("autopilot this", "ship it", "full autopilot"). Jev classifies every prompt (ADR 0002), but its notes are all in shadow, so nothing routes a prompt automatically yet.

## Flow by flow

### Starting a new project

Neither kit documents this flow. pstack's only greenfield mention is that `architect` skips grounding for greenfield work. Both sequences below are assembled from the pieces each kit has.

pstack: `/setup-pstack` once per machine picks models and offers to generate a verification skill. `/poteto-mode` with the goal routes large or unmatched work to `figure-it-out`; design that crosses function boundaries runs `architect` and `arena`, which implements at once unless the user asks for a checkpoint. The guide advises writing the README or tutorial first for shared code, and asking for a plan only after the design settles.

agent-kit:

1. The user states the outcome and done. If the stack is open, `technology-selection` applies.
2. The first data model, CLI or API surface, and file formats are one-way doors, so `design-checkpoint` produces at least two candidates, grafts the best into a base, commits the sketch, and stops for review. This is the only pre-build stop.
3. Multi-slice work gets a `feature-shaping` plan in `plans/<slug>.md` and thin end-to-end slices without further approval.
4. Creating the GitHub repository is outward-facing and needs authorization; `github-rulesets` applies `baseline` after the first push under the same authorization.
5. Once something runs, `create-verification` writes `.agents/skills/verify-<app>/`. No landing mode starts without it.
6. Prompts from the repository go to TypeSafe unless it commits `.agents/jev-opt-out`.
7. In a private repository, `ship` is never available (it requires a public repository); `autopilot-stack` is, and `autopilot-full` runs with only the local `agentic verify status` check behind it.

### Maintaining a project

pstack routes each kind of work to a playbook: Bug fix ("repro first"), Perf issue, Refactoring, Hillclimb, Runtime and Trace forensics. `maintain-verification-skill` runs daily from a scheduled automation. Babysit drives a PR to merge-ready, Shipping lands it, Worktree cleanup reclaims disk, and `correct`, `reflect`, and `automate-me` capture lessons. The benny automation pack is an outer loop that triages issue reports, reproduces them, and drafts fixes.

agent-kit:

- **Bugs:** a plain prompt. The instructions require confirming the symptom, tracing the cause, and one durable regression case; `diagnosing-bugs` covers hard or intermittent ones. There are no perf or refactor playbooks; `code-design` and `verification` carry those rules.
- **Pull requests:** in repositories the user owns, the agent pushes `agent/*` branches, opens PRs ready for review after an adversarial review, and nurses them to green. `babysit-and-ship` has drive, background, threads-only, and check modes. Landing happens only through `autopilot-stack` (the user lands), `ship` (lands the contiguous verified run), or `autopilot-full` (a queue of independent PRs to merged).
- **Verification upkeep:** `maintain-verification` is manual. Since #29, an agent that finds a harness gap or a missing map entry while verifying offers it under "Needs you".
- **Learning:** the agent offers `correct` after the same correction twice; `reflect` writes a session file only after the user approves its findings.
- **Unattended work:** `background-run`, with a done predicate and a trust checklist first.
- **Outer loop:** Hermes into signed T3 jobs that triage, reproduce, fix, verify, and land is a deferred proposal (`docs/design/hermes-outer-loop.md`).

### Adding a feature

pstack's Feature playbook: `how` over the subsystem, `architect` with `arena`, a throughput checkpoint (blocking steps, independent workstreams, shared state, smallest safe decomposition), mandatory delegation of the code to a subagent or `arena`, verification on the matching surface, small ordered commits, `interrogate` when the design is contested, and Opening a PR, which runs `deslop`, `unslop`, and `no-comments`.

agent-kit sets depth by risk, not size:

- **Reversible:** no plan and no question. The agent builds in slices under `code-design`, verifies with `verification` or the repository's verify skill, and runs one fresh `review` child before opening the PR.
- **A fork observation can settle:** `prototype-to-decide`, instead of asking the user.
- **A one-way door:** `design-checkpoint` stops for review; reversible work that does not depend on the shape continues.
- **Multi-slice:** a `feature-shaping` plan, pausing only on an invalidated decision, a blocker, or a checkpoint the user asked for.

The differences: pstack's `architect` runs on any boundary-crossing change and implements immediately unless asked to stop, while agent-kit always stops at a door and never otherwise. pstack mandates delegating the code; agent-kit delegates when it helps. pstack reviews with multi-model `interrogate` panels; agent-kit uses one fresh reviewer, or two for elevated risk.

### A quick prototype

To settle a fork, the kits are nearly identical: `prototype-to-decide` is adapted from pstack's Prototype playbook (scratch directory, variants behind one switcher, one piece of evidence per variant, a recommendation, throwaway code). agent-kit's version is model-invoked, because the instructions forbid asking an abstract "which approach" when an experiment can decide. It decides reversible choices itself and carries on, presents only the user's hard parts (UX taste, game feel, data model) with a default, and sends one-way doors to `design-checkpoint`.

A throwaway spike with no decision behind it has no flow in either kit. Both say "no decision means no prototype": pstack routes to Feature, and agent-kit says to just build.

## What agent-kit lacks

### Gaps that change the four flows

1. **No guide for the user.** pstack ships a ten-page guide with copyable prompts, and `/poteto-help`, which answers "which skill fits" without starting work. agent-kit's README describes its architecture, not how to prompt it. This analysis exists because the flows were not discoverable from the repository.
2. **No new-project sequence.** The pieces exist, but nothing orders them or names the steps an agent cannot infer, such as the Jev opt-out decision and the absence of `ship` in a private repository.
3. **Verification upkeep has no cadence.** pstack runs it daily. agent-kit offers it only when a task stumbles on a gap (#29), and the instructions forbid creating a schedule silently. `design-control-loop` can build a scheduled loop, but it ships to Pi and Codex only, and nothing points to it for this. Every landing mode depends on the verify skill being current.
4. **No lighter mode for a spike.** `prototype-to-decide` inverts the quality bar only for a fork. A plain spike gets the full repository rules (no TODOs, adversarial review before a PR, a durable regression case) unless the user says "throwaway, scratch dir, no PR". pstack's Prototype playbook states the inversion outright.
5. **No independent comment pass.** `code-design` already says comments explain why and code that needs a what-comment is rewritten, and #30 forbids comments that justify workarounds. That is the author's own pass. pstack's `no-comments` hands comments to a reviewer that did not write them, because an author defends its own. agent-kit's PR review reports only blocking findings, so narrating comments and defensive padding pass.

### Playbooks with partial or no counterpart

| pstack | agent-kit |
|---|---|
| Perf issue, Hillclimb | Measurement is covered (`verification/references/command-benchmarks.md`, `explain-the-number.md`) and looping by `background-run`. Nothing joins them into hypothesis, measure, keep or revert. |
| Runtime and Trace forensics | Partly `diagnosing-bugs`. Nothing for reading a captured profile or trace. |
| Visual parity | None. |
| Worktree cleanup | `git-workflow` says when a worktree may be removed; no audit-and-prune flow. |
| `tdd` | No skill. The regression-case rule and `test-behavior-not-implementation.md` cover it loosely. |
| Eval | The evals harness is parked on `agent/reference-full-stack`, so a skill change cannot be measured before it ships. |
| benny automation pack | The deferred Hermes proposal. |

### Deliberately absent

These are choices, not gaps: the `poteto-mode` front door (replaced by always-on instructions); `setup-pstack` and per-role model routing (subagent roles fix their own models); multi-model `interrogate` and `arena` panels (one or two fresh reviewers, and `design-checkpoint` makes its own candidates); the local policy gate (parked by ADR 0001); `figure-it-out` and Orchestrate (absorbed into `background-run` and `references/coordination.md`); `recall`, `bro`, `automate-me`, and `make-bot-ui` (never adopted); and the judgment skills in Codex (frozen).

## Recommendation

ADR 0001 and the 2026-10-07 analysis set the bar: a piece returns when a real session shows the need. This analysis is that evidence for gaps 1 and 2 only. The smallest fix is a user-facing guide in `docs/` that walks the four flows with example prompts and orders the new-project steps. Gap 3 needs one line: offer a cadence for `maintain-verification` once a repository has a verify skill. The rest should wait for a session that trips on them.

The 2026-10-07 analysis listed `babysit-and-ship`, `background-run`, and the vendored `watch-pr` as unexercised in real use. This analysis did not check whether that has changed.
