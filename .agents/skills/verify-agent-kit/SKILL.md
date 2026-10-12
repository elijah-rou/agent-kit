---
name: verify-agent-kit
description: Verify agent-kit (the agentic CLI's verdict ledger, ruleset planning, PR-risk screen, and pull-request readers; the Claude Code and Codex prompt-routing hook; the skill and subagent-role exports each runtime receives; and the Claude Code status line and trial-tools Mod) by driving a checkout's own entry points with every store redirected into a per-run directory. Use to verify an agent-kit pull request, to prove a change to agentic/, claude/, skills/, or the instructions, or before recording a verdict for agent-kit.
---

# Verify agent-kit

Read [features/README.md](features/README.md) before driving, then the feature file you are proving. The control CLI is `.agents/skills/verify-agent-kit/scripts/verify-kit` (shortened to `scripts/verify-kit` below); call it by that path from the root of the checkout that holds it.

## Repository interview

- **Surface:** the terminal and the agent runtimes. Primary: the `agentic` CLI (`agentic/bin/agentic`) and the prompt-routing hook (`agentic/tools/jev/cli.ts task-class --claude-hook`) that Claude Code and Codex run on every prompt. Secondary: the skills, instructions, and roles exported to Claude Code, Codex, and Pi (`claude/skills.txt`, `codex/skills.txt`, `package.json` `pi.skills`, `claude/agents/`), the status line (`claude/statusline.ts`), and the trial-tools Mod (`claude/mods/trial-tools`).
- **Run:** everything runs on Bun from the checkout (`README.md`: `bun install --frozen-lockfile`, then `scripts/validate`). The only dependency is `commander`, locked in `bun.lock`.
- **State:** the routing hook writes records to `$XDG_STATE_HOME/agentic/task-route/`; `agentic verify` writes its ledger to git's common directory unless `AGENTIC_ORCH_STORE` is set. Both are redirected into the run directory, and the merge-gate drive checks that the real ledger did not change. GitHub is read with the user's `gh` login and never written; the drive checks that the live ruleset did not change.
- **Drive:** the repository's harnesses are `scripts/check-skills.ts`, `bun test`, and `claude plugin test` (from `claude/README.md`), which runs the Mod's native tests in the real CLI with no model request. User paths are driven directly: hook events on stdin, CLI commands with their stdout, stderr, and exit codes, each checked against an independent read of GitHub or of the run's stores.
- **Observe:** command output and exit codes, task-route records, the run's ledger rows, the live ruleset, the export and role listings, and the checkout's state before and after.
- **Isolate:** each run has its own directory, `$TMPDIR/verify-agent-kit/<RUN_ID>/`, holding its `XDG_STATE_HOME`, orch store, and scratch repositories, so runs coexist. Drives are synchronous and start no servers, sessions, or containers. The CLI refuses a run ID whose `run.json` it did not write, and refuses to drive a checkout that moved since launch.
- **Recipe:** `create-verification/references/cli-tui.md` (non-interactive commands).

## Launch

```sh
scripts/verify-kit launch --checkout <agent-kit checkout> --install
```

`--checkout` names the checkout to drive; it defaults to the one holding this kit. To verify a pull request, always run this kit from a checkout of the base branch (trunk) and point `--checkout` at a fresh worktree of the head (`git worktree add --detach <path> <head SHA>`), so the pull request never supplies its own verifier. Launch refuses a driven checkout or kit with uncommitted changes or untracked files, because its evidence would name a commit it did not run; `--allow-dirty` overrides that for experiments and marks every result as unable to back a verdict. `--install` first runs `bun install --frozen-lockfile` in that checkout; leave it off when `node_modules/` is already current. Launch records the checkout's revision, a digest of its tracked changes and untracked files, and the kit's own revision, then prints `RUN_ID=ak-<date>-<time>-<pid>`, `EVIDENCE_DIR=...`, and the readiness line `READY verify-agent-kit <RUN_ID>`. Pass that `RUN_ID` to every later command. Teardown is always Cleanup.

## Doctor

Read-only. It answers whether this run is worth driving:

```sh
scripts/verify-kit doctor RUN_ID
```

It checks that the run directory holds its stores and fixtures, that the driven checkout is still at the launched revision with the same tree, that its `agentic` starts and lists its seven tools, and that its `node_modules/` has the `commander` version in `bun.lock`. It reports, without failing, whether `gh` is logged in, whether a TypeSafe key is configured (without reading it), the `claude` CLI version, and which kit drives which checkout. The last line is `DOCTOR PASS <RUN_ID> revision <sha>` or `DOCTOR FAIL <RUN_ID>`, and the output goes to `EVIDENCE_DIR/doctor.txt`. Every drive repeats the revision and tree check before and after it runs; any edit to the checkout fails it, and the fix is a new launch.

## Drive

```sh
scripts/verify-kit drive RUN_ID <feature> [--pr N] [--merged-pr N] [--repo owner/name]
```

Features: `task-route`, `merge-gate`, `pr-state`, `skill-catalog`, `claude-surface`. Each drive ends with `PASS <feature>`, `FAIL <feature>: <check>`, or `SKIP <feature>: <missing prerequisites>`; a SKIP still ran and checked every step whose prerequisites held. The feature files list every entry point and what each step proves.

Which features a change needs. A path matches the first row that names it; anything no row names falls to the last row. Instruction text means Markdown files (`*.md`) and the export lists `claude/skills.txt` and `codex/skills.txt`, in the rows marked instruction text; any other file in those rows (scripts, templates, YAML, JSON, TypeScript, with or without an executable bit) is code and falls to the last row. In every row, code reached only from `agentic verify publish` or `agentic rulesets apply` (their branches in the `cli.ts` files, and helpers only they call, such as `verified` in `rulesets.ts`) writes GitHub, and no drive observes it: a diff to it also needs a test that fails on the parent and passes on the head.

| Changed paths | Drive |
| --- | --- |
| test files (`*.test.ts`, `claude/tests/`, `pi/tests/`) | not mapped: read them as code (last row) |
| `agentic/tools/verify/cli.ts`, `agentic/tools/rulesets/cli.ts` | `merge-gate`, which drives record, status, and plan |
| `agentic/tools/jev/cli.ts`, `route.ts`, `route-task.ts`, `egress.ts` | `task-route` and `merge-gate` (pr-risk shares the CLI and egress) |
| `agentic/tools/jev/pr-risk.ts` | `merge-gate` |
| the rest of `agentic/tools/verify/` and `agentic/tools/rulesets/`, `agentic/vendor/orch/` | `merge-gate` (its contract step checks the verdicts, their statuses, how the ledger decides, and the ruleset's rules and settings) |
| `agentic/tools/pr-feedback/`, `agentic/vendor/watch-pr/` | `pr-state` |
| `agentic/bin/agentic`, `package.json`, `bun.lock` | every feature (`all`) |
| `claude/statusline.ts`, `claude/mods/` | `claude-surface` |
| `scripts/check-skills.ts` | `skill-catalog`, plus `scripts/validate` |
| `.agents/skills/verify-agent-kit/` | its `scripts/`: trunk's kit `all` on the head, plus the head's kit `all` on the head; review the kit's diff as code. Its Markdown sets verification policy: it is instruction text, and passes only when the evidence also cites the user's decision to change that policy |
| `skills/`, `claude/skills/`, `claude/skills.txt`, `codex/skills.txt`, `claude/agents/`, `claude/CLAUDE.md`, `pi/AGENTS.md`, `codex/AGENTS.md`, `codex/native-tools.md`, `pi/WORKTREE_STREAMS.md`, `pi/prompts/`, other `.agents/skills/` text | `skill-catalog` (instruction text: see the verdict rule) |
| `docs/`, `README.md`, licenses | none: read the diff (instruction text) |
| anything else, including `pi/extensions/`, `agentic/tools/upstream-drift/`, `scripts/validate`, `scripts/check-public-safety`, and `.github/` | not mapped: no drive covers it |

Compare parent and head with this kit (from trunk): launch one run with `--checkout <parent worktree>` and one with `--checkout <head worktree>`, drive the same features in both, and compare the result lines and read-back artifacts (`records.jsonl`, `ledger.tsv`, `exports.tsv`, `roles.tsv`). A pull request that adds behavior, or changes output a drive asserts, must add or change the drive step that shows it, in the same pull request. Trunk's kit is the verdict's authority: the head's kit may only add evidence for behavior trunk's kit does not cover, after the verifier reads its new steps as code. A pull request that deliberately changes a checked expectation in both the product and the kit (for example the gate contract) never passes on the head's kit; the verdict list below decides between `verifier-blocked` and `verifier-failed`. `--pr` names the pull request under test for `merge-gate` and `pr-state`; pass it only to the head run, since the driven checkout must be at its head, and `merge-gate` records only a non-passing smoke verdict for it, in the run's own store. A run launched by one kit is driven only by that kit, and every drive fails if the kit's revision or tree changed since launch; `result.txt` records both the launch and the driven revisions and tree digests of the checkout and the kit. The kit trusts its own code: run it from a clean trunk checkout that nothing edits during the run, because a kit edited to skip these checks cannot catch itself.

The verdict follows from what ran. Whatever the verdict, any changed instruction text gets the verifier's read against the pull request's stated intent, and the evidence says agent behavior under it was not observed.

- `live-ui-verified`: every changed path is covered by a drive row, each needed drive PASSes on the head with trunk's kit (and the head's kit for new steps), none of them SKIPs, and the changed behavior appears in a drive step's evidence.
- `unit-test-verified`, for code: changed code no drive covers has a test that exercises the changed lines, fails on the parent or on a revert of the change, and passes on the head; name the test and both runs in the evidence. A green `bun test` or CI run alone is not this.
- `unit-test-verified`, for instruction text: the change is only instruction text (the rows marked instruction text above), `skill-catalog` PASSes on the head with trunk's kit, and the verifier's read of the changed text against the pull request's stated intent finds that it says what the pull request claims and contradicts no other instruction. This skill cannot observe an agent's behavior under new text without model usage, so the evidence says that behavior was not observed. A change only under `docs/`, `README.md`, or licenses needs only the read.
- `verifier-blocked`: a needed drive SKIPs or cannot run; changed code has neither a drive nor such a test; or trunk's kit fails only checks that the pull request deliberately changes in both the product and the kit, the head's kit passes them, and nothing else fails; the evidence then names each such check (from trunk's `result.txt`, which lists every failed check) and the pull request's stated reason for changing it. The user decides: with the merge gate on, only the user can land a pull request without a passing verdict, by posting the `agentic/verdict` status with their reason. An agent never posts a status the ledger does not support.
- `verifier-failed`: a needed drive or test FAILs for any other reason, or changed instruction text does not say what the pull request claims or contradicts another instruction.

## Evidence

Each run's evidence lives in `$XDG_STATE_HOME/verify-agent-kit/evidence/<RUN_ID>/` (default `~/.local/state/verify-agent-kit/evidence/`), outside every checkout, so removing a worktree never removes the evidence a verdict points at. It holds `launch.txt` (the driven checkout, its revision and tree digest, and the kit's revision), `doctor.txt`, `cleanup.txt`, `all.txt` for an `all` run, and one directory per driven feature with a numbered file per step (command, working directory, environment overrides, stdin, exit code, stdout, stderr), its read-back artifacts, and `result.txt` with the drive's last line and the revision it ran against.

Proof standards: drive the same commands the runtimes and users run, against the driven checkout; capture the action and its result; check each result against an independent read (GitHub's own API, the run's stores, the live ruleset) rather than the tool's own summary; observe what a dry run leaves unchanged instead of trusting its name; never call `agentic verify publish` or `agentic rulesets apply`, which change GitHub; report a skipped entry point as skipped, never as proved through another.

## Cleanup

```sh
scripts/verify-kit cleanup RUN_ID
```

It removes `$TMPDIR/verify-agent-kit/<RUN_ID>/` after checking its `run.json` names this run, writes `cleanup.txt`, and keeps the evidence. Nothing else needs stopping: drives run to completion and start no processes, ports, sessions, or containers.

## Control CLI

`scripts/verify-kit` is the only entry point agents need; every command has `--help` with examples, takes all input as arguments, and never prompts.

```sh
scripts/verify-kit launch [--checkout PATH] [--install] [--allow-dirty]
scripts/verify-kit doctor RUN_ID
scripts/verify-kit drive RUN_ID task-route
scripts/verify-kit drive RUN_ID merge-gate --pr 31
scripts/verify-kit drive RUN_ID pr-state --merged-pr 22
scripts/verify-kit drive RUN_ID skill-catalog
scripts/verify-kit drive RUN_ID claude-surface
scripts/verify-kit cleanup RUN_ID
scripts/verify-kit all [--checkout PATH] [--install] [--allow-dirty] [--pr N]
```

`all` launches a run, runs doctor and every feature, cleans up even after a failure, and ends with `ALL <RUN_ID>: <n> pass, <n> fail, <n> skip`, exiting 0 only when doctor passed and no feature failed; a SKIP of a drive the change needs is still `verifier-blocked`. Exit codes: 0 done, 1 a failed check or doctor, 2 a usage error. Errors name the command to run instead. The only step that changes state a run did not create is `bun install`, behind `--install`.

Keep the map honest as agent-kit changes with `maintain-verification`: a pull request that adds, renames, or removes an entry point, or changes output a drive asserts, updates its feature file, its drive step, and the path table in the same change.
