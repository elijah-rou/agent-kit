---
name: create-verification
description: Generate and prove a repository-local verification skill at `.agents/skills/verify-<app>/` that launches the app, health-checks it, drives it the way a user does, captures evidence that survives cleanup, and carries a seeded feature map. Covers web, CLI and TUI, systems, and game projects. Use when the user invokes create-verification or asks for a scripted way to verify this repository's app. Not for a one-off check of a single change.
disable-model-invocation: true
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

Edit scope: everything you write lives in `.agents/skills/verify-<app>/`, including harness scripts and evidence hooks. Change product code only when the checkout actually fails to build or start, and then only the smallest fix, reported to the user; a working base is never modified to make verification easier. A missing asset irrelevant to the surface may be created as marked verification scaffolding and removed in cleanup.

Completion criterion: each of the five questions has an answer backed by a path or command, and a recipe is chosen.

## 2. Generate the skill

Write `.agents/skills/verify-<app>/SKILL.md` with frontmatter `name: verify-<app>` and a `description` naming the app, the surface, and when to use it. Include these sections, with no placeholders left:

- **Launch:** the exact start command, the readiness signal (log line, port answering, prompt), and teardown. For a short-lived CLI, launch means build once, then start each drive in its own isolated session or container.
- **Doctor:** one read-only check that answers "is this instance worth driving?": process or container up, expected build or revision, port owned by this run, auth valid.
- **Drive:** the harness recipe with this repository's real selectors and commands. Prefer stable handles (accessible names, data attributes, prompt strings, routes, input scripts) over coordinates, timing, and tab order.
- **Evidence:** what to capture and where. Name one evidence directory per run, outside everything cleanup removes and ignored by git. State the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state; verify side effects (files, rows, messages, installed state) as well as what is visible; use mocks only where a production boundary already isolates the external system; when using a dry-run mode, observe what it actually skips (files, network, git refs) instead of trusting its name.
- **Cleanup:** stop only what this run started, by recorded PID, session name, or container ID, never by process name. Remove instances and scratch state, never evidence.
- **Helpers:** every shipped script is executable and its invocation appears in the skill body.

Completion criterion: every section names real commands and paths from this repository.

## 3. Seed the feature map

Create `.agents/skills/verify-<app>/features/README.md` plus one file for each of the top three to five user-facing features, found from routes, commands, menus, or docs. Follow `references/feature-map-example/`: the README holds baseline preconditions, driving conventions, and proof and skip rules; each feature file has an H1, one paragraph, and exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`. The map is the repository's verification source: a proof that drives one convenient entry point is incomplete when the map lists others.

Check the map: every feature file is listed in `features/README.md`, every listed file exists, and each feature file has exactly the four sections above.

Completion criterion: the map passes that check.

## 4. Prove the generated skill end to end

Follow the generated skill's own text, literally:

1. Launch and wait for the readiness signal.
2. Run Doctor.
3. Drive one mapped feature through one of its listed entry points.
4. Capture evidence to the named evidence directory.
5. Run Cleanup.
6. Confirm the evidence still exists and is non-empty at its named location.
7. Confirm nothing this run started remains: no session, process, container, or bound port.

When a step fails, fix the generated skill, run its Cleanup, and start again from step 1. A skill never executed end to end is a draft, not a deliverable.

Completion criterion: steps 6 and 7 were observed on the final version of the skill.

## Reply

Lead with anything the user must decide or provide (credentials, entitlements, hardware). Then the skill path, the features mapped, the proof run (feature driven, evidence path, and the listing that shows it survived cleanup), the map check, and known gaps. Point to `maintain-verification` for keeping the map honest as the app changes.
