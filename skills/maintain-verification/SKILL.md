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

## Repository

`<owner/repo>` is origin's GitHub repository, read from `git remote get-url origin` in the main checkout; a scheduled run's prompt names it. A bare `gh` in a fork resolves the parent repository, so every `gh` command in this skill runs with `GH_REPO=<owner/repo>` in its environment, and `gh repo` commands also take `<owner/repo>` as their argument. The repository is one the user owns when `GH_REPO=<owner/repo> gh repo view <owner/repo> --json owner -q .owner.login` equals `GH_REPO=<owner/repo> gh api user -q .login`.

## Pass

0. **Locate the target.** Find the skill under `.agents/skills/verify-*/`. With several candidates, ask which one, recommending the one whose surface the user's request names. With none, end `blocked` and point to `create-verification`. Then keep one upkeep pull request per skill at a time. That matters only where step 6 could open one, so this check runs only when origin is a GitHub repository the user owns (Repository); a manual run whose main checkout has no origin, or whose origin is not on GitHub or not the user's, skips it and goes on to step 1, since the audit works in any repository. Fetch origin (a scheduled run has already fetched) and list the open pull requests with `GH_REPO=<owner/repo> gh pr list --state open --limit 1000 --json number,headRefName,isCrossRepository`. An upkeep pull request for this skill is one whose head is in this repository (`isCrossRepository` false, so a fork's pull request named like one never stops upkeep) and whose head branch is exactly `agent/verify-upkeep-<app>-<YYYY-MM-DD>`, optionally followed by `-<N>` (step 6 names every run's branch this way), where `<app>` is the skill's directory name after `verify-` and the date follows it directly, so `verify-web` does not match `verify-web-admin`'s branches. Other open pull requests that change the skill's directory, such as feature work updating its map, do not stop the pass. If one is open, the run, scheduled or manual, reports it and ends `clean` with no edits, asking nothing, even when the user's request names that pull request: a second upkeep pull request would duplicate it. Fixing the open one is its own pull request's work, not this pass's.

   If the fetch or a `gh` command here fails, the ownership check included, a scheduled run ends `blocked`, naming the command and its error. A manual run says the check could not run, naming the command and its error, and goes on to step 1; a missing `gh` or network blocks only the steps that need them. Never assume no upkeep pull request is open: step 6 pushes nothing unless its own repeat of this check succeeds.

1. **Index hygiene.** Read `features/README.md` and list its sibling files. Fix missing, extra, duplicate, or dead entries, check that each feature file has its four sections, check that the control CLI has exactly one drive target per feature file and every subcommand and Dev loop lever `create-verification` step 2 requires for this product (a missing one is a harness gap, step 5), and check that every agent runtime the user works with here can discover the skill: each one that does not read `.agents/skills/` has a discovery symlink resolving to the skill's `SKILL.md`. Add a missing symlink or repair a broken one as part of this step.

2. **Source wave.** Spawn one read-only subagent per feature file, concurrently, using the `review` role where the harness defines one, and otherwise a role or type without write or shell-mutation tools. Each explains how the feature works from source, flags likely drift with `file:line` citations, and returns one live-verification recipe. Children never drive the app, never edit files, and never publish. Return shape: feature summary, source entry points, likely drift or `none`, one recipe. If subagents are unavailable, read each feature yourself and say so.

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

6. **Land or stop.** For `changed`, re-read every changed file, recheck the index, sections, drive targets, levers, and symlinks, and commit on one branch named `agent/verify-upkeep-<app>-<YYYY-MM-DD>`, dated with the run's day; if that name already exists on origin (a same-day rerun), add `-2`, `-3`, and so on rather than pushing over it. In a repository the user owns (Repository), just before pushing, repeat step 0's upkeep pull request check, counting only same-repository heads as step 0 does: if one opened since, push nothing and end `blocked`, naming it and the local branch; if the check fails, push nothing, and a scheduled run ends `blocked` as step 0 says while a manual run leaves the branch for the user, naming it and the failed command. Otherwise push it to origin and open one pull request with `GH_REPO=<owner/repo> gh pr create --head <branch>`. In any other repository, or when ownership cannot be read, leave the branch for the user. For `clean` or `blocked`, push nothing and report; a scheduled run that ends `blocked` first keeps its proven edits as Scheduled runs step 3 says.

7. **Policy rule.** A change to the skill's `SKILL.md` or `features/README.md` (its verdict, proof, and skip rules) is a verification-policy change, and so is adding, removing, or repointing a runtime's discovery symlink to the skill (such as `.claude/skills/verify-<app>`), since that swaps the rules a runtime loads: `agentic verify record` refuses every passing verdict but a countersign for it, so such a `changed` pull request lands only by countersign (the `babysit-and-ship` skill's Countersign rule). A pull request that changes only feature files or drive scripts takes an ordinary verdict. A skill whose self-policy rule is worded differently from `create-verification`'s current rule is covered by that path check anyway: it needs no migration, and its older wording is not drift.

Keep run notes (features covered, unreachable prerequisites, confirmed drift) in a scratch location outside the repository; do not commit them.

## Scheduled runs

This section is what a weekly upkeep schedule runs, and it answers stored prompts marked `[t3-automation upkeep v1]`. The `t3-automation` skill renders each schedule's title, prompt, and timing (Upkeep schedule, below). Its prompt names the repository, its main checkout, the trunk, the skill path, and the schedule's title, repeats the run's core limits, and tells the run to read this installed file and follow this section, or to change nothing and report the schedule obsolete when this file is gone or this section no longer names that marker. Stored schedules depend on this section's heading, its marker, and the upkeep branch pattern of step 6, and a test that `scripts/validate` runs fails when this file stops recognizing them (`skills/t3-automation/scripts/spec.test.ts`). A schedule outlives an edit to this file, so keep all three. A change that must break what older prompts rely on bumps `VERSION` in `t3-automation`'s `scripts/spec.ts` and names the new marker here; older schedules then report themselves obsolete, and the user replaces them (`t3-automation`, List, disable, delete).

A scheduled run is the same pass with no one watching, in this order:

1. **Check the mode first.** Read this thread's `runtimeMode` with `t3_thread_configuration`. If it is anything but `full-access`, or the read fails, end `blocked` at once, naming the mode: a mode that asks for approval stops the run on a prompt no one is there to answer. Never change the mode.
2. **Every early exit before the run creates anything.** Check these in order, stopping at the first that fails:
   1. The main checkout path the prompt names exists, is a git checkout, and its origin is the prompt's `<owner/repo>` (Repository).
   2. The repository is still the user's (Repository).
   3. `git fetch origin` in the main checkout, which only updates refs; never check out, edit, or commit in that checkout.
   4. The skill is on trunk: `git cat-file -e origin/<trunk>:<skill path>/SKILL.md`. The schedule is created only once the skill is on trunk, so a miss means the skill has since moved or gone.
   5. Step 0's upkeep pull request check.

   A missing checkout or a different origin (check 1), a different owner (check 2), or a missing skill (check 4) makes the schedule obsolete: end `blocked`, naming the schedule's title and telling the user to disable it (`t3-automation`, Stopping). Any other failed command ends `blocked` as step 0 says.
3. **Its own worktree, then remove it.** Only after those checks pass, add a worktree off `origin/<trunk>` outside the main checkout (`git-workflow`), and run steps 0 to 7 there. Keep run notes and live evidence in a scratch directory outside that worktree, since removing the worktree deletes everything in it; the reply's evidence paths point there. On every exit from then on, whatever the outcome:
   1. Run the live pass's final teardown.
   2. If the run ends `blocked` holding proven edits (fixes re-driven live in step 4 and kept in step 5), commit them on a local branch named as step 6 names it, push nothing, and name that branch in the reply.
   3. `git worktree remove` the worktree, adding `--force` only when what remains uncommitted is this run's own unproven edits, which a `blocked` run discards.
   4. If the removal fails anyway, name the worktree's path and the error in the reply.

   A local branch holding commits not on origin stays, and the reply names it.
4. **Ask nothing.** Step 0 takes the skill the prompt names; anything else that would need the user ends the pass `blocked`, saying what it needs. If a permission prompt, guard, or forge rule asks or refuses anyway, do not wait or retry the action in another form: end `blocked`, naming the action.
5. **Never merge.** A `changed` pull request waits for the user, and one that step 7 makes a policy change lands only by countersign.

## Upkeep schedule

A run the user started (not a scheduled one) ends, whatever its outcome, by keeping the skill it located on a weekly schedule, created as the `t3-automation` skill's Create section says for the `upkeep` kind; its Rules (approval, runtime mode, project and binding, exact titles, stopping, report) apply unchanged. Its checks use `t3_project_read`, `t3_thread_configuration`, `list_scheduled_tasks`, and `schedule_task`; without any of them, create nothing. Before those checks, the repository must be one the user owns (Repository). The spec comes from the installed kit's script (`t3-automation`, Known kinds, which defines the installed kit): `bun <kit>/skills/t3-automation/scripts/spec.ts upkeep --skill <skill path> --checkout <main checkout>`, which exits nonzero, among other reasons, until the skill is on origin's trunk and until the installed kit has this section's marker. A schedule, enabled or disabled, whose title equals the spec's title exactly is the existing one: report it and leave it unchanged. Otherwise call `schedule_task` with no `projectId`, passing the spec's `title`, `prompt`, `schedule`, and `bindToCurrentThread` unchanged, so each run posts into this thread with its settings.

When a check fails or the script exits nonzero, create nothing; report which check failed or the script's error, and that the user can run `maintain-verification` by its command by hand, weekly or after a change to a mapped feature.

## Reply

A scheduled run's reply starts with the line `Scheduled weekly upkeep: <owner/repo>`. A run that ends early (before step 1) replies with only that line when scheduled, the outcome, and one reason line:

- `Upkeep pull request open: #<number> (<branch>)`, and for a manual run, `Not auditing while it is open; land or close it, then rerun.`
- `Runtime mode <mode> asks for approval; disable the schedule "<title>" to stop upkeep, or delete it and rerun maintain-verification from a full-access thread in the repository's project to recreate it.`
- `Schedule "<title>" is obsolete (<reason>); disable it with update_scheduled_task enabled false, or in T3's schedule list.` The reason is `main checkout <path> missing`, `origin is no longer <owner/repo>`, `repository no longer owned by <login>`, or `skill not on trunk: <skill path>`.
- `Blocked: <command> failed: <error>`, or `No verification skill found; run create-verification.`

Otherwise, lead with product gaps and anything blocked. Then the outcome, coverage per feature (source and live, with evidence paths), drift fixed, harness fixes and their re-proofs, the index, section, drive-target, lever, and symlink check from step 6, the branch or pull request if any, for a manual run whether step 0's upkeep pull request check ran, was skipped and why, or failed, and for a scheduled run any worktree it could not remove. A manual run, early or not, ends with the Upkeep schedule result: the created schedule as `t3-automation`'s Report rule says, the existing schedule with its ID, enabled state, and next run, or the check that failed.
