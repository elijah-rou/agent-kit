---
name: maintain-verification
description: Audit and repair a repository's verification skill and feature map under `.agents/skills/verify-<app>/`, with one read-only source reader per feature, one live pass that drives every feature, triage into doc drift, harness gap, or product gap, and an outcome of clean, changed, or blocked. Use when the user invokes maintain-verification, asks to audit the verify skill, or its weekly upkeep schedule runs it. Not for creating one; use create-verification.
disable-model-invocation: true
---

# Maintain a verification skill

A feature map rots as soon as the app changes. Cover every feature file from source and drive every feature live; the unit of rigor is the feature, not each sentence.

## Outcome

End with exactly one, and say which:

- **clean:** every feature had source and live coverage, and nothing needs changing; or the run ended early with nothing to do (step 0). No branch.
- **changed:** one commit series of proven corrections on one branch.
- **blocked:** coverage could not finish, or a proven fix could not land safely. Say exactly what blocked it.

## Edit scope

Edit only the verification skill's own directory (its `SKILL.md`, `features/`, and the helpers it owns) and its discovery symlinks in other runtimes' project skill directories. Never edit product code. A behavior the map describes that the app no longer has is either doc drift (fix the map) or a product regression (report it; never paper over it in the docs).

## Pass

0. **Locate the target.** Find the skill under `.agents/skills/verify-*/`. With several candidates, ask which one, recommending the one whose surface the user's request names. With none, end `blocked` and point to `create-verification`. Then keep one upkeep pull request per skill at a time. Fetch origin (a scheduled run has already fetched) and list the open pull requests with `gh pr list --state open --limit 1000 --json number,headRefName`. An upkeep pull request for this skill is one whose head branch is exactly `agent/verify-upkeep-<app>-<YYYY-MM-DD>`, optionally followed by `-<N>` (step 6 names every run's branch this way), where `<app>` is the skill's directory name after `verify-` and the date follows it directly, so `verify-web` does not match `verify-web-admin`'s branches. Other open pull requests that change the skill's directory, such as feature work updating its map, do not stop the pass. If one is open, the run, scheduled or manual, reports it and ends `clean` with no edits, asking nothing, even when the user's request names that pull request: a second upkeep pull request would duplicate it. Fixing the open one is its own pull request's work, not this pass's.

   If the fetch or `gh` fails, end `blocked`, naming the command and its error; never assume no upkeep pull request is open.

1. **Index hygiene.** Read `features/README.md` and list its sibling files. Fix missing, extra, duplicate, or dead entries, check that each feature file has its four sections, check that the control CLI has exactly one drive target per feature file and every subcommand and Dev loop lever `create-verification` step 2 requires for this product (a missing one is a harness gap, step 5), and check that every agent runtime the user works with here can discover the skill: each one that does not read `.agents/skills/` has a discovery symlink resolving to the skill's `SKILL.md`. Add a missing symlink or repair a broken one as part of this step.

2. **Source wave.** Spawn one read-only subagent per feature file, concurrently, using a role or type without write or shell-mutation tools. Each explains how the feature works from source, flags likely drift with `file:line` citations, and returns one live-verification recipe. Children never drive the app, never edit files, and never publish. Return shape: feature summary, source entry points, likely drift or `none`, one recipe. If subagents are unavailable, read each feature yourself and say so.

3. **Reconcile.** Every feature file has a returned summary. Merge recipes into as few app states as practical. Spot-check cited drift; do not re-prove clean claims. Scan recent changes for user-facing surfaces missing from the map, and call one missing only with a concrete source path.

4. **Live pass.** Required even when the source looks clean. Only you drive the app, following the skill's own Launch model: one long-lived instance driven serially for servers and UIs, or a fresh isolated session per drive for short-lived CLIs. Drive every feature at least once. Hold three invariants throughout, whatever fails:
   1. **Health before driving.** Run Doctor before the first drive, on each fresh session, and after any failed drive. When Doctor cannot see the failure (a wedged UI on a healthy process), reset to a known state or relaunch.
   2. **Evidence survives cleanup.** Check the named evidence location after every cleanup; do not assume.
   3. **Nothing outlives its use.** Clean up each drive's residue whether the session is stuck, exited, or shared. For a shared instance, clean the residue, not the instance.

   A Doctor failure caused by skill drift is drift: fix it within edit scope and retry once, restarting only what the fix invalidated, before calling the pass blocked. A feature is `verified-unreachable` only with the concrete missing prerequisite (auth, entitlement, OS, hardware, external state) and the route attempted; a prerequisite the map omits is drift. Re-drive every harness fix live before keeping it. Final teardown happens after the last drive, including re-proofs.

5. **Triage** each finding:
   - **Doc drift:** the user-POV description is wrong or missing. Fix the map.
   - **Harness gap:** working behavior the harness cannot drive, or a skill without the control CLI that `create-verification` step 2 defines. Fix the harness to that contract; shipped scripts are executable and their invocation is in the skill body. A new control CLI is proven by driving every feature through it in the live pass. A Dev loop lever added or changed here is kept only after it passes `create-verification` step 4's step 9 checks (for `--repeat`, on a feature that passed this pass's live drive in step 4), which prove it works, not only that it runs; a check that step says cannot be proved is reported as a gap. A drive that fails because the seed data lacks a precondition is a harness gap too: add it to Launch's seed steps, or, when the seed cannot provide it, record why in the feature's `Gotchas`.
   - **Product gap:** the app is actually broken. Record it for the user with its evidence; keep it out of the corrections.

6. **Land or stop.** For `changed`, re-read every changed file, recheck the index, sections, drive targets, levers, and symlinks, and commit on one branch named `agent/verify-upkeep-<app>-<YYYY-MM-DD>`, dated with the run's day; if that name already exists on origin (a same-day rerun), add `-2`, `-3`, and so on rather than pushing over it. Just before pushing, repeat step 0's upkeep pull request check: if one opened since, push nothing and end `blocked`, naming it and the local branch. In a repository the user owns, push it and open one pull request; otherwise leave the branch for the user. For `clean` or `blocked`, change nothing and report.

7. **Policy rule.** A change to the skill's `SKILL.md` or `features/README.md` (its verdict, proof, and skip rules) is a verification-policy change, and so is adding, removing, or repointing a runtime's discovery symlink to the skill (such as `.claude/skills/verify-<app>`), since that swaps the rules a runtime loads: `agentic verify record` refuses every passing verdict but a countersign for it, so such a `changed` pull request lands only by countersign (the `babysit-and-ship` skill's Countersign rule). A pull request that changes only feature files or drive scripts takes an ordinary verdict. A skill whose self-policy rule is worded differently from `create-verification`'s current rule is covered by that path check anyway: it needs no migration, and its older wording is not drift.

Keep run notes (features covered, unreachable prerequisites, confirmed drift) in a scratch location outside the repository; do not commit them.

## Scheduled runs

The weekly T3 schedule that the Upkeep schedule section creates runs this pass in a fresh thread whose prompt names only the repository's main checkout path, trunk, and the skill path. It names no pull request or branch, since one named when the schedule was created goes stale; the run finds the skill's state itself. The instructions' rule on schedules gives `maintain-verification` upkeep schedules the user's standing approval. A scheduled run is the same pass with no one watching, in this order:

1. **Check the mode first.** Read this thread's `runtimeMode` with `t3_thread_configuration`. If it is anything but `full-access`, or the read fails, end `blocked` at once, naming the mode: a mode that asks for approval stops the run on a prompt no one is there to answer. Never change the mode.
2. **Every early exit before the run creates anything.** In the main checkout, run `git fetch origin`, which only updates refs; never check out, edit, or commit in that checkout. Confirm the skill is on trunk with `git cat-file -e origin/<trunk>:<skill path>/SKILL.md`. If it is not, end `blocked`, naming the schedule's title (`Weekly verification upkeep: <repository> verify-<app>`) and telling the user to delete that schedule: it is created only once the skill is on trunk, so the skill has since moved or gone. Then run step 0's upkeep pull request check. A failed command ends `blocked` as step 0 says.
3. **Its own worktree, then remove it.** Only after those checks pass, add a worktree off `origin/<trunk>` outside the main checkout (`git-workflow`), and run steps 0 to 7 there. On every exit from then on, whatever the outcome, run the live pass's final teardown, then `git worktree remove` it, adding `--force` only to discard this run's own uncommitted, unproven edits when it ends `blocked` mid-fix. A local branch holding commits not on origin stays, and the reply names it.
4. **Ask nothing.** Step 0 takes the skill the prompt names; anything else that would need the user ends the pass `blocked`, saying what it needs. If a permission prompt, guard, or forge rule asks or refuses anyway, do not wait or retry the action in another form: end `blocked`, naming the action.
5. **Never merge.** A `changed` pull request waits for the user, and one that step 7 makes a policy change lands only by countersign.

## Upkeep schedule

A run the user started (not a scheduled one) ends, whatever its outcome, by keeping the skill it located on a weekly schedule. The instructions' rule on schedules gives `maintain-verification` upkeep schedules the user's standing approval in a repository the user owns that has a verification skill, so this needs no question. Create the schedule only when all of these hold, checking in this order and stopping at the first that fails:

- The repository is one the user owns (its `origin` is under the user's own GitHub account).
- T3's schedule tools are available (`schedule_task`, `list_scheduled_tasks`, `t3_thread_configuration`).
- The skill is on origin's trunk: `git cat-file -e origin/<trunk>:<skill path>/SKILL.md` succeeds after this run's fetch. A skill that so far exists only in an open pull request gets no schedule; the first run the user starts after it lands creates one.
- `list_scheduled_tasks` for the repository's T3 project shows no schedule that already runs `maintain-verification` for this skill. If one does, report it and leave it unchanged.
- This thread's `runtimeMode`, read with `t3_thread_configuration`, is `full-access`. With `bindToCurrentThread: false`, each run's fresh thread inherits this thread's runtime settings, so a schedule created from a thread that asks for approval would stall its runs on the first prompt. Never change this thread's mode to meet this; the user reruns the pass from a `full-access` thread to create the schedule.

Then call `schedule_task` with:

- `schedule`: `{type: "fixed_time", timeOfDay: "09:00", weekdays: [1]}`, Monday 09:00 local time;
- `bindToCurrentThread: false`, so each run gets a fresh thread instead of posting into this one;
- `projectId`: the repository's T3 project, omitted when this thread belongs to it;
- `title`: `Weekly verification upkeep: <repository> verify-<app>`;
- `prompt`: the command that invokes `maintain-verification` by name in the runtime the schedule inherits from this thread (its slash command), followed by `Weekly scheduled upkeep of <skill path> in <main checkout path>, against origin's <trunk>.` The path is the repository's main checkout (the first entry of `git worktree list`), never a T3 worktree, which T3 may remove.

Report the returned schedule ID, the cadence, and the returned `nextRunAt`. When a condition fails, create nothing, and report which one and that the user can run `maintain-verification` by its command by hand, weekly or after a change to a mapped feature.

## Reply

A scheduled run's reply starts with the line `Scheduled weekly upkeep: <repository>`. A run that ends early (before step 1) replies with only that line when scheduled, the outcome, and one reason line:

- `Upkeep pull request open: #<number> (<branch>)`, and for a manual run, `Not auditing while it is open; land or close it, then rerun.`
- `Runtime mode <mode> asks for approval; delete the schedule "<title>" and rerun maintain-verification from a full-access thread to recreate it.`
- `Skill not on trunk: <skill path>; delete the schedule "<title>".`
- `Blocked: <command> failed: <error>`, or `No verification skill found; run create-verification.`

Otherwise, lead with product gaps and anything blocked. Then the outcome, coverage per feature (source and live, with evidence paths), drift fixed, harness fixes and their re-proofs, the index, section, drive-target, lever, and symlink check from step 6, and the branch or pull request if any. A manual run, early or not, ends with the Upkeep schedule result: the created or existing schedule with its ID, cadence, and next run, or the condition that failed.
