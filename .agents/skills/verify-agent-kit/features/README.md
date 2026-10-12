# agent-kit verification map

This directory is the maintained source for verifying what agent-kit does for the people and runtimes that use it. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Every command runs from the root of the checkout under test, and only that checkout's entry points run: `bun agentic/bin/agentic`, `bun agentic/tools/jev/cli.ts`, `bun claude/statusline.ts`, and `claude/mods/trial-tools`. The `agentic` installed on `PATH` is never used.
- `scripts/verify-kit launch` created this run and printed its `RUN_ID`, and `scripts/verify-kit doctor RUN_ID` ends with `DOCTOR PASS`.
- The run directory `$TMPDIR/verify-agent-kit/<RUN_ID>/` holds this run's `XDG_STATE_HOME` (`state/`), orch store (`orch/`), and two scratch git repositories: `fixture/`, and `fixture-optout/`, which holds `.agents/jev-opt-out`. No drive writes to the user's real task-route ledger or to any repository's verdict ledger.
- Evidence goes to `.agents/skills/verify-agent-kit/evidence/<RUN_ID>/<feature>/`, which cleanup never touches.
- Optional prerequisites, reported by doctor: `gh` logged in (merge-gate, pr-state), a TypeSafe key in `TYPESAFE_API_KEY` or the macOS keychain item `typesafe-jev` (task-route's Jev steps), and the `claude` CLI (claude-surface's Mod steps).

## Driving conventions

- Drive through `scripts/verify-kit drive RUN_ID <feature>`. Use raw commands only to diagnose a failure the drive reported.
- Read-only GitHub calls only: merged and open pull requests are read, never commented on, published to, or merged. `agentic verify publish` and `agentic rulesets apply` change GitHub and are never driven here.
- A verdict recorded by a drive goes into this run's own orch store, never into a repository's ledger.
- To compare parent and head for a pull request, launch one run in a checkout of each and drive the same feature in both.

## Proof and skip reporting

- Each step's evidence file holds the command, working directory, environment overrides, stdin, exit code, stdout, and stderr.
- A side effect is proved by reading it back: task-route records from `state/`, the ledger row from `orch/ledger.tsv`, the export listing in `exports.tsv`.
- Each drive ends with `PASS <feature>`, `FAIL <feature>: <check>`, or `SKIP <feature>: <missing prerequisite>`. A SKIP still runs and checks every step whose prerequisites hold; a failure in those steps is a FAIL, not a SKIP.
- A skipped entry point is never reported as verified through a different one.

## Feature file contract

Each feature file starts with an H1 title and one paragraph describing the behavior a user sees. It then has exactly four H2 sections, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-kit` (starting with `Preconditions:` and the drive target), and `Gotchas`.

## Features

- [Prompt routing](./task-route.md): the UserPromptSubmit hook for Claude Code and Codex, its records, its withheld and opted-out prompts, and the manual route command.
- [Merge gate](./merge-gate.md): recording and checking a fresh verifier's verdict, and planning the GitHub ruleset that requires it.
- [Pull request state](./pr-state.md): reading a pull request's feedback, checks, and readiness, and watching it.
- [Skill catalog](./skill-catalog.md): the skills and subagent roles each runtime receives, and repository skill discovery.
- [Claude Code surface](./claude-surface.md): the quota status line and the trial-tools Mod.

## Not mapped yet

- Pi extensions under `pi/extensions/` load only inside a Pi session, which spends model usage. `bun test pi/tests` covers them at the unit level; a verdict that rests on it says so.
- `agentic upstream-drift` and `agentic orch` (outside `verify`) are maintenance tools without a user journey here.
