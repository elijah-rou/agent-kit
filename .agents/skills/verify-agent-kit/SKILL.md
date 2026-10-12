---
name: verify-agent-kit
description: Verify agent-kit (the agentic CLI's verdict ledger, ruleset planning, and pull-request readers; the Claude Code and Codex prompt-routing hook; the skill and subagent-role exports each runtime receives; and the Claude Code status line and trial-tools Mod) by driving this checkout's own entry points with every store redirected into a per-run directory. Use to verify an agent-kit pull request, to prove a change to agentic/, claude/, skills/, or the instructions, or before recording a verdict for agent-kit.
---

# Verify agent-kit

Read [features/README.md](features/README.md) before driving, then the feature file you are proving. Run every command from the root of the checkout under test. The control CLI is `.agents/skills/verify-agent-kit/scripts/verify-kit`; call it by that path (shortened to `scripts/verify-kit` below).

## Repository interview

- **Surface:** the terminal and the agent runtimes. Primary: the `agentic` CLI (`agentic/bin/agentic`) and the prompt-routing hook (`agentic/tools/jev/cli.ts task-class --claude-hook`) that Claude Code and Codex run on every prompt. Secondary: the skills, instructions, and roles exported to Claude Code, Codex, and Pi (`claude/skills.txt`, `codex/skills.txt`, `package.json` `pi.skills`, `claude/agents/`), the status line (`claude/statusline.ts`), and the trial-tools Mod (`claude/mods/trial-tools`).
- **Run:** everything runs on Bun from the checkout (`README.md`: `bun install --frozen-lockfile`, then `scripts/validate`). The only dependency is `commander`, locked in `bun.lock`.
- **State:** the routing hook writes records to `$XDG_STATE_HOME/agentic/task-route/`; `agentic verify` writes its ledger to git's common directory unless `AGENTIC_ORCH_STORE` is set. Both are redirected into the run directory. GitHub is read with the user's `gh` login and never written.
- **Drive:** the repository's harnesses are `scripts/check-skills.ts`, `bun test`, and `claude plugin test` (from `claude/README.md`), which runs the Mod's native tests in the real CLI with no model request. User paths are driven directly: hook events on stdin, CLI commands with their stdout, stderr, and exit codes.
- **Observe:** command output and exit codes, task-route records, the run's ledger rows, the export and role listings, and the checkout's `git status` before and after.
- **Isolate:** each run has its own directory, `$TMPDIR/verify-agent-kit/<RUN_ID>/`, holding its `XDG_STATE_HOME`, orch store, and scratch repositories, so runs coexist. Drives are synchronous and start no servers, sessions, or containers. The CLI refuses a run ID whose `run.json` it did not write for this checkout.
- **Recipe:** `create-verification/references/cli-tui.md` (non-interactive commands).

## Launch

```sh
scripts/verify-kit launch --install
```

`--install` first runs `bun install --frozen-lockfile` in the checkout; leave it off when `node_modules/` is already current. Launch creates the run directory, records the checkout's revision and a digest of its tracked and untracked files, and prints `RUN_ID=ak-<date>-<time>-<pid>`, `EVIDENCE_DIR=...`, and the readiness line `READY verify-agent-kit <RUN_ID>`. Pass that `RUN_ID` to every later command. Teardown is always Cleanup.

## Doctor

Read-only. It answers whether this run is worth driving:

```sh
scripts/verify-kit doctor RUN_ID
```

It checks that the run directory holds its stores and fixtures, that the checkout is still at the launched revision with the same tree, that this checkout's `agentic` starts and lists its seven tools, and that `node_modules/` has the `commander` version in `bun.lock`. It reports, without failing, whether `gh` is logged in, whether a TypeSafe key is configured (without reading it), and the `claude` CLI version, because those decide which steps can run. The last line is `DOCTOR PASS <RUN_ID> revision <sha>` or `DOCTOR FAIL <RUN_ID>`, and the output goes to `EVIDENCE_DIR/doctor.txt`. Edit nothing in the checkout during a run; doctor fails after any edit, and the fix is a new launch.

## Drive

```sh
scripts/verify-kit drive RUN_ID <feature> [--pr N] [--merged-pr N] [--repo owner/name]
```

Features: `task-route`, `merge-gate`, `pr-state`, `skill-catalog`, `claude-surface`. Each drive ends with `PASS <feature>`, `FAIL <feature>: <check>`, or `SKIP <feature>: <missing prerequisite>`. The feature files list every entry point and what each step proves.

Which features a change needs:

| Changed paths | Drive |
| --- | --- |
| `agentic/tools/jev/`, the hook wiring | `task-route` |
| `agentic/tools/verify/`, `agentic/tools/rulesets/`, `agentic/vendor/orch/` | `merge-gate` |
| `agentic/tools/pr-feedback/`, `agentic/vendor/watch-pr/` | `pr-state` |
| `skills/`, `claude/skills/`, `claude/skills.txt`, `codex/skills.txt`, `claude/agents/`, `claude/CLAUDE.md`, `pi/AGENTS.md`, `codex/AGENTS.md`, `.agents/skills/` | `skill-catalog` |
| `claude/statusline.ts`, `claude/mods/` | `claude-surface` |
| `pi/extensions/` | not mapped: `bun test pi/tests`, and say the verdict rests on unit tests |
| `docs/` only | none: read the diff |

To prove a pull request, launch one run in a checkout of its parent and one in a checkout of its head, drive the same features in both, and compare. `--pr` names the pull request under test for `merge-gate` and `pr-state`; it records a verdict only in the run's own store.

A verdict for agent-kit follows from what ran. A change to code passes as `live-ui-verified` when its mapped drives pass on the head and show the changed behavior against the parent. A change only to skills or instructions has no runtime surface this skill can drive without model usage: `skill-catalog` must pass on the head, and the verifier reads the changed text against the pull request's stated intent. Record that as `unit-test-verified`, and write in the evidence that agent behavior under the new text was not observed. A failed drive is `verifier-failed`; a drive that cannot run is `verifier-blocked`.

## Evidence

Each run's evidence lives in `.agents/skills/verify-agent-kit/evidence/<RUN_ID>/`, which git ignores and cleanup never touches. It holds `launch.txt`, `doctor.txt`, `cleanup.txt`, `all.txt` for an `all` run, and one directory per driven feature with a numbered file per step (command, working directory, environment overrides, stdin, exit code, stdout, stderr), any read-back artifacts (`ledger.tsv`, `exports.tsv`, `roles.tsv`), and `result.txt` with the drive's last line.

Proof standards: drive the same commands the runtimes and users run, against this checkout; capture the action and its result; prove side effects by reading them back from the run's stores; never call `agentic verify publish` or `agentic rulesets apply`, which change GitHub; report a skipped entry point as skipped, never as proved through another.

## Cleanup

```sh
scripts/verify-kit cleanup RUN_ID
```

It removes `$TMPDIR/verify-agent-kit/<RUN_ID>/` after checking its `run.json` names this run and checkout, writes `cleanup.txt`, and keeps the evidence. Nothing else needs stopping: drives run to completion and start no processes, ports, sessions, or containers.

## Control CLI

`scripts/verify-kit` is the only entry point agents need; every command has `--help` with examples, takes all input as arguments, and never prompts.

```sh
scripts/verify-kit launch [--install]
scripts/verify-kit doctor RUN_ID
scripts/verify-kit drive RUN_ID task-route
scripts/verify-kit drive RUN_ID merge-gate --pr 31
scripts/verify-kit drive RUN_ID pr-state --merged-pr 22
scripts/verify-kit drive RUN_ID skill-catalog
scripts/verify-kit drive RUN_ID claude-surface
scripts/verify-kit cleanup RUN_ID
scripts/verify-kit all [--install] [--pr N]
```

`all` launches a run, runs doctor and every feature, cleans up even after a failure, and ends with `ALL <RUN_ID>: <n> pass, <n> fail, <n> skip`, exiting 0 only when doctor passed and no feature failed. Exit codes: 0 done, 1 a failed check or doctor, 2 a usage error. Errors name the command to run instead. The only step that changes state a run did not create is `bun install`, behind `--install`.

Keep the map honest as agent-kit changes with `maintain-verification`: a pull request that adds, renames, or removes an entry point updates its feature file and drive target in the same change.
