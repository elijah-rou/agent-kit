# agent-kit verification map

This directory is the maintained source for verifying what agent-kit does for the people and runtimes that use it. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Only the driven checkout's entry points run: its `agentic/bin/agentic`, `agentic/tools/jev/cli.ts`, `agentic/tools/git-guard/cli.ts`, `claude/statusline.ts`, and `claude/mods/trial-tools`. The `agentic` installed on `PATH` is never used.
- To verify a pull request, the kit runs from a checkout of the base branch and drives the head's worktree through `--checkout`.
- `scripts/verify-kit launch` created this run and printed its `RUN_ID`, and `scripts/verify-kit doctor RUN_ID` ends with `DOCTOR PASS`. Every drive refuses a checkout that moved since launch.
- The run directory `$TMPDIR/verify-agent-kit/<RUN_ID>/` holds this run's `XDG_STATE_HOME` (`state/`), orch store (`orch/`), and two scratch git repositories: `fixture/`, and `fixture-optout/`, which holds `.agents/jev-opt-out`. No drive writes to the user's real task-route ledger or to any repository's verdict ledger.
- Evidence goes to `$XDG_STATE_HOME/verify-agent-kit/evidence/<RUN_ID>/<feature>/` (default under `~/.local/state`), outside every checkout; cleanup never touches it.
- Optional prerequisites, reported by doctor: `gh` logged in (merge-gate, pr-state), a TypeSafe key in `TYPESAFE_API_KEY` or the macOS keychain item `typesafe-jev` (the Jev steps of task-route and merge-gate), and the `claude` CLI (claude-surface's Mod steps).

## Driving conventions

- Drive through `scripts/verify-kit drive RUN_ID <feature>`. Use raw commands only to diagnose a failure the drive reported.
- Read-only GitHub calls only: merged and open pull requests are read, never commented on, published to, or merged. `agentic verify publish` and `agentic rulesets apply` change GitHub and are never driven here; a drive that runs a dry run reads the live state before and after and fails on any change.
- A verdict recorded by a drive is a non-passing smoke verdict in this run's own orch store; the drive fails if the real ledger changes.
- To compare parent and head for a pull request, launch one run with `--checkout` on each and drive the same feature in both.

## Proof and skip reporting

- Each step's evidence file holds the command, working directory, environment overrides, stdin, exit code, stdout, and stderr.
- A side effect is proved by reading it back: task-route records (`records.jsonl`), the ledger row (`ledger.tsv`), the live ruleset (`ruleset-before.json` and the after check), the export listing (`exports.tsv`). A tool's output is checked against an independent read, such as GitHub's API for a head SHA.
- Each drive ends with `PASS <feature>`, `FAIL <feature>: <check>`, or `SKIP <feature>: <missing prerequisites>`. A SKIP still runs and checks every step whose prerequisites hold; a failure in those steps is a FAIL, not a SKIP. A `gh` failure is a FAIL; only an absent prerequisite is a SKIP.
- A skipped entry point is never reported as verified through a different one.

## Feature file contract

Each feature file starts with an H1 title and one paragraph describing the behavior a user sees. It then has exactly four H2 sections, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-kit` (starting with `Preconditions:` and the drive target), and `Gotchas`.

## Features

- [Prompt routing](./task-route.md): the UserPromptSubmit hook for Claude Code and Codex, its records, its withheld and opted-out prompts, and the manual route command.
- [Merge gate](./merge-gate.md): recording and checking a fresh verifier's verdict, planning the GitHub ruleset that requires it, and the PR-risk screen before landing.
- [Pull request state](./pr-state.md): reading a pull request's feedback, checks, and readiness, and watching it.
- [Skill catalog](./skill-catalog.md): the skills and subagent roles each runtime receives, and repository skill discovery.
- [Claude Code surface](./claude-surface.md): the quota status line and the trial-tools Mod.
- [Git guard](./git-guard.md): the PreToolUse hook (not yet wired by bootstrap) that matches command text to refuse `--no-verify` everywhere and git publication from subagents other than an `autopilot-owner`, and what it over-refuses and misses.

## Not mapped yet

- Pi extensions under `pi/extensions/` load only inside a Pi session, which spends model usage. `bun test pi/tests` covers them at the unit level; a verdict that rests on it says so.
- `agentic verify publish` and `agentic rulesets apply` change GitHub; their refusals (a changed patch, no verdict for the head) are not observed here.
- `agentic upstream-drift` and `agentic orch` (outside `verify`) are maintenance tools without a user journey here.
- `scripts/validate`, `scripts/check-public-safety`, and `.github/workflows/` run in CI; no drive observes them.
