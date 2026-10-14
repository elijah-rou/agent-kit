---
name: create-verification
description: Generate and prove a repository-local verification skill at `.agents/skills/verify-<app>/` whose control CLI launches the app, health-checks it, drives it the way a user does, captures evidence that survives cleanup, and carries a seeded feature map. Covers web, CLI and TUI, systems, and game projects. Use when the user invokes create-verification or asks for a scripted way to verify this repository's app, or as the first unit when a landing mode (`babysit-and-ship`) starts in a repository with no `.agents/skills/verify-*/` skill. Not for a one-off check of a single change.
---

# Create a verification skill

Generate the skill an agent will read cold, mid-task, having never seen the app. Every command in it must come from this repository and must have run once.

## 1. Interview the repository, not the user

Answer from the code; ask the user only what you cannot observe:

- **Surface:** what a user touches (web UI, CLI or TUI, desktop app, API, library, simulation, game). Pick the primary surface and note the rest.
- **Run:** the repository's own start command, ports, environment variables, seed data, auth, and container setup.
- **Drive:** existing harnesses first (end-to-end specs, expect scripts, PTY helpers, debug ports, replay tools). Only then a generic recipe.
- **Observe:** what can be captured (screenshots, terminal transcripts, response bodies, logs, exit codes, stored state, frame times).
- **Isolate:** whether two instances can run side by side (ports, data directories, profiles, containers). If not, the generated skill refuses to drive an instance it did not start.

Then read the recipe for the domain:

| Domain | Recipe |
|---|---|
| Web, Electron, IDE UI | `references/web.md` |
| CLI, TUI, installers | `references/cli-tui.md` |
| Systems: libraries, services, storage, concurrency | `references/systems.md` |
| Games and real-time simulations | `references/games.md` |

Edit scope: everything you write lives in `.agents/skills/verify-<app>/`, including harness scripts and evidence hooks, except the discovery symlinks step 2 describes. Change product code only when the checkout actually fails to build or start, and then only the smallest fix, reported to the user; a working base is never modified to make verification easier. A missing asset irrelevant to the surface may be created as marked verification scaffolding and removed in cleanup.

Completion criterion: each of the five questions has an answer backed by a path or command, and a recipe is chosen.

## 2. Generate the skill

Write `.agents/skills/verify-<app>/SKILL.md` with frontmatter `name: verify-<app>` and a `description` naming the app, the surface, and when to use it. Include these sections, with no placeholders left:

- **Launch:** the exact start command, the readiness signal (log line, prompt), and teardown. Launch reaches a usable state from an empty data directory, running any migrations and seed steps itself. Ready means usable: a process or port that answers is not ready while its initialization still runs. For a short-lived CLI, launch means build once, then start each drive in its own isolated session or container.
- **Doctor:** one read-only check that answers "is this instance worth driving?": process or container up, expected build or revision, port owned by this run, auth valid, and the toolchain comparison Dev loop defines.
- **Drive:** the harness recipe with this repository's real selectors and commands. Prefer stable handles (accessible names, data attributes, prompt strings, routes, input scripts) over coordinates, timing, and tab order.
- **Evidence:** what to capture and where. Name one evidence directory per run, outside everything cleanup removes and ignored by git. State the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state; verify side effects (files, rows, messages, installed state) as well as what is visible; use mocks only where a production boundary already isolates the external system; when using a dry-run mode, observe what it actually skips (files, network, git refs) instead of trusting its name. State that evidence never holds account identifiers or secrets: drive with test accounts, redirect home and state directories into the run where the app allows, and scan the evidence directory before committing any of it (`verification`'s evidence hygiene).
- **Cleanup:** stop only what this run started, by recorded PID, session name, or container ID, never by process name. Remove instances and scratch state, never evidence.
- **Control CLI:** one executable entry point under the skill's `scripts/`, so every agent drives the app the same way instead of writing its own scripts each session. It has subcommands for launch, doctor, and cleanup, one drive target per mapped feature (added in step 3 as each feature is seeded), `all`, which runs launch, doctor, and every feature, then cleans up even after a failure, ends with a line counting passes, failures, and skips, and exits 0 only if no feature failed, and the levers Dev loop requires. Every input is a flag or argument; it never prompts. Each subcommand's `--help` shows real examples. Each drive ends with one line a script can check: `PASS <feature>`, `FAIL <feature>: <check>`, or `SKIP <feature>: <missing prerequisite>` when a credential, entitlement, hardware, or external state the feature needs is absent. Errors say what to run instead. A step that can change state this run did not create requires an explicit flag. Launch, Doctor, Drive, and Cleanup show its invocations; raw commands appear only as diagnosis aids. Any other shipped helper is executable and its invocation appears in the skill body.
- **Dev loop:** the control CLI levers that replace the scripts agents otherwise write around it each session, with their invocations, for each the product needs:
  - When the repository has its own tests: `test` builds the project and runs them inside the same environment the drives use (image, container, or toolchain), passing a test filter through.
  - Always: `--repeat N` on a drive or on `test` runs that check N times, keeps each run's evidence in its own subdirectory so a later pass never overwrites a failure, and reports how many runs passed and the check where each failure stopped.
  - When CI pins toolchain versions (compiler, runtime, interpreter, or the editor a plugin is tested in): Doctor compares this environment's versions with CI's (for a CI matrix, the entry matching this environment, or every entry when none matches), reports each mismatch with the file and version that differ, and records it in the evidence. A mismatch fails Doctor only in an environment the skill builds itself, such as its own image, whose pin is within the edit scope, or under an explicit `--strict-toolchain` flag. Elsewhere it is a warning, because the fix is the user's machine or CI's pin.

- **Verdict rules:** which ledger verdict (`agentic verify`) a pull request earns from what the skill ran, starting with this rule, word for word: "A change to this skill's verdict rules (this `SKILL.md`, or the proof and skip rules in `features/README.md`) sets this repository's verification policy and never passes on its own: its verdict is `verifier-blocked`, and it lands only by countersign (the `babysit-and-ship` skill's Countersign rule). Both files are policy paths `agentic verify --help` lists, so `agentic verify record` refuses any other passing verdict for them. A change only to feature files or drive scripts takes an ordinary verdict: trunk's copy of this skill decides it, and the reviewer treats a removed or loosened check as a finding." The pull request that adds the skill is such a change: it lands only by countersign. Open it off trunk, outside any stack, so it never blocks a ship run's verified ceiling.

Make the skill discoverable to every agent runtime the user works with in this repository. A runtime that reads project skills only from its own directory, not from `.agents/skills/`, gets a relative symlink from that directory to `.agents/skills/verify-<app>`.

Completion criterion: every section names real commands and paths from this repository, Verdict rules holds the self-policy rule word for word, the control CLI's `--help` runs, and each symlink resolves to the skill's `SKILL.md`.

## 3. Seed the feature map

Create `.agents/skills/verify-<app>/features/README.md` plus one file for each of the top three to five user-facing features, found from routes, commands, menus, or docs. Follow `references/feature-map-example/`: the README holds baseline preconditions, driving conventions, and proof and skip rules; each feature file has an H1, one paragraph, and exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`. The map is the repository's verification source: a proof that drives one convenient entry point is incomplete when the map lists others. As you write each feature file, add its drive target to the control CLI, with a `--help` example, and name that target in the file's driving section, right after `Preconditions:`. Seed data is state the run creates, not an external prerequisite. A precondition a journey needs that you find missing while creating the skill goes into Launch's seed steps. On a later run whose seed data lacks one, that drive reports `FAIL`, not `SKIP`, naming the missing precondition; the task that hit it reports it, and the next `maintain-verification` pass triages it as a harness gap, adding it to Launch's seed steps or, when the seed cannot provide it, recording why in the feature's `Gotchas`. Never weaken the journey to make it pass.

Check the map: every feature file is listed in `features/README.md`, every listed file exists, each feature file has exactly the four sections above, and the control CLI has exactly one drive target per feature file.

Completion criterion: the map passes that check.

## 4. Prove the generated skill end to end

Follow the generated skill's own text, literally:

1. Launch and wait for the readiness signal.
2. Run Doctor.
3. Drive one mapped feature through one of its listed entry points, with the control CLI.
4. Capture evidence to the named evidence directory.
5. Run Cleanup.
6. Confirm the evidence still exists and is non-empty at its named location.
7. Confirm nothing this run started remains: no session, process, container, bound port, or scratch copy.
8. Run the control CLI's `all` once; confirm it reports every feature, no feature fails, each skip names its missing prerequisite, and nothing it started remains.
9. Show that each lever Dev loop requires for this product works, not only that it runs:
   - `test`, when the repository has tests: run it with a filter naming one test and confirm from its output that exactly that test ran. A filter that matches nothing and still exits 0 fails this step. When the test runner has no filter, confirm an unfiltered `test` ran a nonzero number of tests, and report selection as a gap.
   - `--repeat 3` on a feature step 8 passed: it reports 3 of 3 passed, with three separate evidence subdirectories. Fewer passes means state leaks between runs or the feature is flaky; diagnose it before changing the drive, and never add retries to hide it. When every feature skipped in step 8, this lever cannot be proved; report that as a gap, not a pass.
   - The toolchain comparison, when CI pins toolchain versions: copy the checkout to a scratch directory outside it, alter one CI pin in the copy, and run Doctor against the copy. A local version manager may follow the altered pin and hide the mismatch, so change the pin in a direction the manager will not follow, or hold the local side apart with the manager's own override for the Doctor run. For example, lower the version in `go.mod` (Go switches only to a newer toolchain), or set `RUSTUP_TOOLCHAIN` to another installed toolchain. Report a gap only when neither is possible. Confirm Doctor reports the mismatch and that its exit status follows Dev loop's rule: a warning and exit 0 on the host, a failure in an environment the skill builds itself. Then run it with `--strict-toolchain` and confirm it fails. Run Cleanup for any run launched against the copy, then delete the copy, which may hold copies of ignored files such as secrets; that run's evidence backs no verdict.

   Then repeat step 7's check.

When a step fails, fix the generated skill, run its Cleanup, and start again from step 1. A skill never executed end to end is a draft, not a deliverable. If you proved it in a stand-in for the real target (a container in place of a fresh machine, a local stack in place of a remote one), list every setup step the stand-in did that the target will not; those steps stay unverified until a run on the real target covers them.

Completion criterion: steps 6, 7, 8, and 9 were observed on the final version of the skill.

## Reply

Lead with anything the user must decide or provide (credentials, entitlements, hardware), and that the pull request adding the skill lands only when the user approves it in words (a countersign). Then the skill path, the features mapped, the proof run (feature driven, evidence path, the listing that shows it survived cleanup, and on a stand-in, the setup steps it did that the target will not), every toolchain mismatch Doctor reported, the map check, every skipped feature with its missing prerequisite, and known gaps. Point to `maintain-verification` for keeping the map honest as the app changes: in T3, in a repository the user owns, the first `maintain-verification` run by its command after the pull request lands on trunk also schedules its weekly upkeep through `t3-automation` (its Upkeep schedule section).
