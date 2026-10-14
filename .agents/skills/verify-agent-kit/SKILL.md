---
name: verify-agent-kit
description: Verify agent-kit (the agentic CLI's verdict ledger and local merge gate, ruleset planning, PR-risk screen, and pull-request readers; the Claude Code prompt-routing hook; the Claude Code git guard hook; the skill and subagent-role exports each runtime receives; and the Claude Code status line and trial-tools Mod) by driving a checkout's own entry points with every store redirected into a per-run directory. Use to verify an agent-kit pull request, to prove a change to agentic/, claude/, skills/, or the instructions, or before recording a verdict for agent-kit.
---

# Verify agent-kit

Read [features/README.md](features/README.md) before driving, then the feature file you are proving. The control CLI is `.agents/skills/verify-agent-kit/scripts/verify-kit` (shortened to `scripts/verify-kit` below); call it by that path from the root of the checkout that holds it.

## Repository interview

- **Surface:** the terminal and the agent runtimes. Primary: the `agentic` CLI (`agentic/bin/agentic`), the prompt-routing hook (`agentic/tools/jev/cli.ts task-class --claude-hook`) that Claude Code runs on every prompt, the git guard (`agentic/tools/git-guard/cli.ts --claude-hook`) that Claude Code runs before every Bash, Monitor, and PowerShell command when an install wires it, and the skill reminder (`agentic/tools/skill-reminder/cli.ts --claude-hook`) that it runs before every file edit when an install wires it. Secondary: the skills, instructions, and roles exported to Claude Code and Pi (`claude/skills.txt`, `package.json` `pi.skills`, `claude/agents/`), the status line (`claude/statusline.ts`), and the trial-tools Mod (`claude/mods/trial-tools`).
- **Run:** everything runs on Bun from the checkout (`README.md`: `bun install --frozen-lockfile`, then `scripts/validate`). The only dependency is `commander`, locked in `bun.lock`.
- **State:** the routing hook writes records to `$XDG_STATE_HOME/agentic/task-route/`; `agentic verify` writes its ledger to git's common directory unless `AGENTIC_ORCH_STORE` is set. Both are redirected into the run directory, and the verdict-gate drive checks that the real ledger did not change. GitHub is read with the user's `gh` login and never written; the drive checks that the live ruleset did not change.
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

Features: `task-route`, `verdict-gate`, `pr-state`, `skill-catalog`, `claude-surface`, `git-guard`, `skill-reminder`. Each drive ends with `PASS <feature>`, `FAIL <feature>: <check>`, or `SKIP <feature>: <missing prerequisites>`; a SKIP still ran and checked every step whose prerequisites held. The feature files list every entry point and what each step proves.

Which features a change needs. A path matches the first row that names it; anything no row names falls to the last row. Instruction text means Markdown files (`*.md`), license files, and the export list `claude/skills.txt`, in the rows marked instruction text; any other file in those rows (scripts, templates, YAML, JSON, TypeScript, with or without an executable bit) is code and falls to the last row. `scripts/check-skills.ts`, which `skill-catalog` runs, keeps that Markdown from executing: across the skill, role, prompt, and `docs/` folders it refuses inline shell and fences opened with an exclamation mark, nested `.claude` folders and links, a `SKILL.md` below a skill's top folder (names compared case-insensitively), frontmatter not in the plain form, and any frontmatter key outside a short allowlist (no tool grants, hooks, or permission modes). In every row, code reached only from `agentic rulesets apply` (its branch in `rulesets/cli.ts`, and helpers only it calls, such as `verified` in `rulesets.ts`) writes GitHub, and code reached only by recording a passing verdict (the `countersigned` path in `verify/cli.ts`) is never driven: a diff to either also needs a test that fails on the parent and passes on the head.

| Changed paths | Drive |
| --- | --- |
| test files (`*.test.ts`, `claude/tests/`, `pi/tests/`) | not mapped: read them as code (last row) |
| `agentic/tools/verify/cli.ts`, `agentic/tools/rulesets/cli.ts` | `verdict-gate`, which drives record, the countersign refusal, status, and plan |
| `agentic/tools/jev/cli.ts`, `route.ts`, `route-task.ts`, `egress.ts` | `task-route` and `verdict-gate` (pr-risk shares the CLI and egress) |
| `agentic/tools/jev/pr-risk.ts` | `verdict-gate` |
| `agentic/tools/jev/route-report.ts` | `task-route`, whose report step drives `agentic jev route-report` offline over the run's own records; `route-report.test.ts` covers the rest |
| the rest of `agentic/tools/verify/` and `agentic/tools/rulesets/`, `agentic/vendor/orch/` | `verdict-gate` (its contract step checks the verdicts, how the ledger and the local gate decide, when a countersign is allowed, and the ruleset's rules and settings) |
| `agentic/tools/pr-feedback/`, `agentic/vendor/watch-pr/` | `pr-state` |
| `agentic/bin/agentic`, `package.json`, `bun.lock` | every feature (`all`) |
| `claude/statusline.ts`, `claude/mods/` | `claude-surface` |
| `agentic/tools/git-guard/` | `git-guard` (Pi's `git-interceptor` applies the same policy; `pi/extensions/` stays in the last row) |
| `agentic/tools/skill-reminder/` | `skill-reminder` |
| `scripts/check-skills.ts` | `skill-catalog`, plus `scripts/validate` |
| `.agents/skills/verify-agent-kit/` | trunk's kit `all` on the head, plus the head's kit `all` on the head. Its feature files and `scripts/` take ordinary verdicts, since trunk's kit decides each one: review the kit's diff as code, and the audit lane treats a removed or loosened check, in a drive or in a feature file's stated step, as a finding. Only its `SKILL.md` (the verdict rules and this table) and `features/README.md` (the proof and skip rules) are policy paths, with a file git tracks at the kit's own or its `features` name and a runtime's link to the kit (`.claude/skills/verify-agent-kit`), either of which would swap in other rules: a change to any of them sets verification policy and never passes on its own, so the verdict is `verifier-blocked` and only a countersign (below) lands it |
| `skills/*/scripts/` (scripts that ship inside a skill) | no drive: `bun test skills`, which `scripts/validate` runs, holds their tests (`baseline.test.ts` for `skills/repo-baseline/scripts/baseline.ts`), so a changed script passes only by the code rule for `unit-test-verified` below; one with no test, such as `skills/show-me-your-work/scripts/log.sh`, is read as code (last row) |
| `skills/`, `claude/skills/`, `claude/skills.txt`, `claude/agents/`, `claude/CLAUDE.md`, `pi/AGENTS.md`, `pi/WORKTREE_STREAMS.md`, `pi/prompts/`, other `.agents/skills/` text | `skill-catalog` (instruction text: see the verdict rule) |
| `docs/`, `README.md`, `AGENTS.md`, `CLAUDE.md`, licenses | `skill-catalog` and a read of the diff (instruction text) |
| anything else, including `pi/extensions/`, `agentic/tools/upstream-drift/`, `scripts/validate`, `scripts/check-public-safety`, and `.github/` | not mapped: no drive covers it |

Compare parent and head with this kit (from trunk): launch one run with `--checkout <parent worktree>` and one with `--checkout <head worktree>`, drive the same features in both, and compare the result lines and read-back artifacts (`records.jsonl`, `ledger.tsv`, `exports.tsv`, `roles.tsv`). A pull request that adds behavior, or changes output a drive asserts, must add or change the drive step that shows it, in the same pull request. Trunk's kit is the verdict's authority: the head's kit may only add evidence for behavior trunk's kit does not cover, after the verifier reads its new steps as code. A pull request that deliberately changes a checked expectation in both the product and the kit (for example the gate contract) never passes on the head's kit alone, since trunk's kit still fails it; the verdict list below decides between `verifier-blocked` and `verifier-failed`. `--pr` names the pull request under test for `verdict-gate` and `pr-state`; pass it only to the head run, since the driven checkout must be at its head, and `verdict-gate` records only a non-passing smoke verdict for it, in the run's own store. A run launched by one kit is driven only by that kit, and every drive fails if the kit's revision or tree changed since launch; `result.txt` records both the launch and the driven revisions and tree digests of the checkout and the kit. The kit trusts its own code: run it from a clean trunk checkout that nothing edits during the run, because a kit edited to skip these checks cannot catch itself.

The verdict follows from what ran. Whatever the verdict, any changed instruction text gets the verifier's read against the pull request's stated intent, and the evidence says agent behavior under it was not observed.

- `live-ui-verified`: every changed path is covered by a drive row, each needed drive PASSes on the head with trunk's kit (and the head's kit for new steps), none of them SKIPs, and the changed behavior appears in a drive step's evidence.
- `unit-test-verified`, for code: changed code no drive covers has a test that exercises the changed lines, fails on the parent or on a revert of the change, and passes on the head; name the test and both runs in the evidence. A green `bun test` or CI run alone is not this.
- `unit-test-verified`, for instruction text: the change is only instruction text (the rows marked instruction text above), `skill-catalog` PASSes on the head with trunk's kit, and the verifier's read of the changed text against the pull request's stated intent finds that it says what the pull request claims and contradicts no other instruction. This skill cannot observe an agent's behavior under new text without model usage, so the evidence says that behavior was not observed. A change only under `docs/`, `README.md`, `AGENTS.md`, `CLAUDE.md`, or licenses needs the same `skill-catalog` pass, whose checker also covers `docs/`.
- `verifier-blocked`: a needed drive SKIPs or cannot run; changed code has neither a drive nor such a test; the change touches a policy path (the one list, `POLICY_PATHS` in `agentic/tools/verify/verify.ts`, which `agentic verify --help` prints: this kit's `SKILL.md` and `features/README.md`, a file at the kit's own or its `features` name, a runtime's link to the kit, and the landing gate; never a feature file or a drive script), which sets the verification policy this verdict rests on and never passes on its own, and for which `agentic verify record` refuses every passing verdict but `countersigned`, though it still gets every drive its rows name; or trunk's kit fails only checks that the pull request deliberately changes in both the product and the kit, the head's kit passes them, and nothing else fails; the evidence then names each such check (from trunk's `result.txt`, which lists every failed check) and the pull request's stated reason for changing it. The user decides: such a pull request lands only by countersign, below.
- `countersigned`: not the verifier's verdict. When a fresh verifier's verdict is `verifier-blocked` only because the change touches a policy path, or only because trunk's kit fails checks the pull request deliberately changes (as above), and every other lane passes, the user may approve that pull request in their own words, shown its head SHA and patch ID. The coordinator then records `countersigned` for the head with `--patch` naming that patch ID and evidence quoting the user's message; `agentic verify record` refuses it unless a `verifier-blocked` verdict covers the current patch and `--patch` names it, and it appends the blocked verdict's verifier ID and evidence to the countersign's. A changed patch needs a new round and new words from the user. It passes the gate. No agent ever posts a forge status by hand.
- `verifier-failed`: a needed drive or test FAILs for any other reason, or changed instruction text does not say what the pull request claims or contradicts another instruction.

## Evidence

Each run's evidence lives in `$XDG_STATE_HOME/verify-agent-kit/evidence/<RUN_ID>/` (default `~/.local/state/verify-agent-kit/evidence/`), outside every checkout, so removing a worktree never removes the evidence a verdict points at. It holds `launch.txt` (the driven checkout, its revision and tree digest, and the kit's revision), `doctor.txt`, `cleanup.txt`, `all.txt` for an `all` run, and one directory per driven feature with a numbered file per step (command, working directory, environment overrides, stdin, exit code, stdout, stderr), its read-back artifacts, and `result.txt` with the drive's last line and the revision it ran against.

Proof standards: drive the same commands the runtimes and users run, against the driven checkout; capture the action and its result; check each result against an independent read (GitHub's own API, the run's stores, the live ruleset) rather than the tool's own summary; observe what a dry run leaves unchanged instead of trusting its name; never call `agentic rulesets apply`, which changes GitHub, and never record a passing verdict; report a skipped entry point as skipped, never as proved through another.

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
scripts/verify-kit drive RUN_ID verdict-gate --pr 31
scripts/verify-kit drive RUN_ID pr-state --merged-pr 22
scripts/verify-kit drive RUN_ID skill-catalog
scripts/verify-kit drive RUN_ID claude-surface
scripts/verify-kit drive RUN_ID git-guard
scripts/verify-kit drive RUN_ID skill-reminder
scripts/verify-kit cleanup RUN_ID
scripts/verify-kit all [--checkout PATH] [--install] [--allow-dirty] [--pr N]
```

`all` launches a run, runs doctor and every feature, cleans up even after a failure, and ends with `ALL <RUN_ID>: <n> pass, <n> fail, <n> skip`, exiting 0 only when doctor passed and no feature failed; a SKIP of a drive the change needs is still `verifier-blocked`. Exit codes: 0 done, 1 a failed check or doctor, 2 a usage error. Errors name the command to run instead. The only step that changes state a run did not create is `bun install`, behind `--install`.

Keep the map honest as agent-kit changes with `maintain-verification`: a pull request that adds, renames, or removes an entry point, or changes output a drive asserts, updates its feature file, its drive step, and the path table in the same change. A feature file or drive step alone takes an ordinary verdict; the path table lives in this `SKILL.md`, so a change to it is a policy change that lands by countersign.
