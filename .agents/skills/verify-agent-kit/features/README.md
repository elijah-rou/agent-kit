# agent-kit verification map

This directory is the maintained source for verifying what agent-kit does for the people and runtimes that use it. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Only the driven checkout's entry points run: its `agentic/bin/agentic`, `agentic/tools/jev/cli.ts`, `agentic/tools/git-guard/cli.ts`, `agentic/tools/skill-reminder/cli.ts`, `claude/statusline.ts`, and `claude/mods/trial-tools`. The `agentic` installed on `PATH` is never used.
- To verify a pull request, the kit runs from a checkout of the base branch and drives the head's worktree through `--checkout`.
- `scripts/verify-kit launch` created this run and printed its `RUN_ID`, and `scripts/verify-kit doctor RUN_ID` ends with `DOCTOR PASS`. Every drive refuses a checkout that moved since launch.
- The run directory `$TMPDIR/verify-agent-kit/<RUN_ID>/` holds this run's `XDG_STATE_HOME` (`state/`), orch store (`orch/`), and two scratch git repositories: `fixture/`, and `fixture-optout/`, which holds `.agents/jev-opt-out`. No drive writes to the user's real task-route ledger or to any repository's verdict ledger.
- Evidence goes to `$XDG_STATE_HOME/verify-agent-kit/evidence/<RUN_ID>/<feature>/` (default under `~/.local/state`), outside every checkout; cleanup never touches it.
- Optional prerequisites, reported by doctor: `gh` logged in (verdict-gate, pr-state), a TypeSafe key in `TYPESAFE_API_KEY` or the macOS keychain item `typesafe-jev` (the Jev steps of task-route and verdict-gate), and the `claude` CLI (claude-surface's Mod steps).

## Driving conventions

- Drive through `scripts/verify-kit drive RUN_ID <feature>`. Use raw commands only to diagnose a failure the drive reported.
- Read-only GitHub calls only: merged and open pull requests are read, never commented on, given a status, or merged. `agentic rulesets apply` changes GitHub and is never driven here; a drive that runs a dry run reads the live state before and after and fails on any change.
- A verdict recorded by a drive is a non-passing smoke verdict in this run's own orch store. The only passing verdicts a drive attempts are ones `record` must refuse: countersigns with no `verifier-blocked` verdict or a patch the user was never shown, and `unit-test-verified` for a pull request that touches a policy path. The drive fails if the real ledger changes.
- To compare parent and head for a pull request, launch one run with `--checkout` on each and drive the same feature in both.

## Proof and skip reporting

- Each step's evidence file holds the command, working directory, environment overrides, stdin, exit code, stdout, and stderr.
- A side effect is proved by reading it back: task-route records (`records.jsonl`), the ledger row (`ledger.tsv`), the live ruleset (`ruleset-before.json` and the after check), the export listing (`exports.tsv`). A tool's output is checked against an independent read, such as GitHub's API for a head SHA.
- Each drive ends with `PASS <feature>`, `FAIL <feature>: <check>`, or `SKIP <feature>: <missing prerequisites>`. A SKIP still runs and checks every step whose prerequisites hold; a failure in those steps is a FAIL, not a SKIP. A `gh` failure is a FAIL; only an absent prerequisite is a SKIP.
- A skipped entry point is never reported as verified through a different one.

## Feature file contract

Feature files are not policy paths: a change to one takes an ordinary verdict, which trunk's kit decides, and the audit lane treats a removed or loosened step as a finding. This index (the proof and skip rules) and the kit's `SKILL.md` (the verdict rules and the path table) are policy paths.

Each feature file starts with an H1 title and one paragraph describing the behavior a user sees. It then has exactly four H2 sections, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-kit` (starting with `Preconditions:` and the drive target), and `Gotchas`.

## Features

- [Prompt routing](./task-route.md): the Claude Code UserPromptSubmit hook, its records, its withheld and opted-out prompts, the manual route command, and the route report.
- [Verdict gate](./verdict-gate.md): recording a fresh verifier's verdict, the local gate that checks it before each merge, the countersign refusal, planning the GitHub history backstop, and the advisory PR-risk score.
- [Pull request state](./pr-state.md): reading a pull request's feedback, checks, and readiness, and watching it.
- [Skill catalog](./skill-catalog.md): the skills and subagent roles each runtime receives, and repository skill discovery.
- [Claude Code surface](./claude-surface.md): the quota status line and the trial-tools Mod.
- [Git guard](./git-guard.md): the PreToolUse hook that matches command text to refuse skipping hooks (`--no-verify`, `-n` on `commit` or `am`, skip variables, `core.hooksPath` and `hook.*` changes) everywhere and git publication and `gh pr merge` from subagents other than an `autopilot-owner`, and what it over-refuses and misses.
- [Skill reminder](./skill-reminder.md): the PreToolUse hook that reminds a session, and each subagent, to load `code-design` on its first source edit, and never refuses an edit.

## Not mapped yet

- Pi extensions under `pi/extensions/` load only inside a Pi session, which spends model usage. `bun test pi/tests` covers them at the unit level; a verdict that rests on it says so.
- `agentic rulesets apply` changes GitHub and is not observed here. A passing verdict, including a recorded `countersigned`, is never driven, so the gate's pass path and a carried countersign are covered by the contract step and `agentic/tools/verify/verify.test.ts`, not by a drive.
- `agentic upstream-drift` and `agentic orch` (outside `verify`) are maintenance tools without a user journey here.
- `scripts/validate`, `scripts/check-public-safety`, and `.github/workflows/` run in CI; no drive observes them.
- Scripts that ship inside skills (`skills/*/scripts/`) have no drive; `bun test skills` runs the tests of those that have one.
