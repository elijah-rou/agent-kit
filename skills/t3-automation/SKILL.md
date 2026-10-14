---
name: t3-automation
description: Create, list, disable, and delete T3 Code scheduled automations correctly, rendering each known schedule's exact title, prompt, and timing with this skill's script. Use whenever an agent or skill creates a T3 schedule (such as maintain-verification's weekly upkeep), or the user asks to add, list, stop, or remove a T3 automation. Not for a mode's own tick or pull-request watch, which that mode creates and removes itself.
---

# T3 automation

A T3 schedule persists in T3's store for one project on one machine, outside the repository and outside the installed kit. Reverting the skill that created it, or rolling the installed kit back, neither removes nor disables it, and its stored prompt keeps firing. So the schedule's title, prompt, and timing come from code, `scripts/spec.ts`, and every stored prompt must fail safe on its own.

Only an agent can call T3's schedule tools (`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`); the script never calls T3. Without those tools, create nothing and say so.

## Rules

- **Approval.** The instructions' rule on schedules decides which schedules need no question: `maintain-verification` upkeep schedules, and CI intake schedules, in a repository the user owns that has a verification skill. Any other schedule needs the user's go first.
- **Runtime mode.** Create a schedule only from a thread whose T3 runtime mode asks for no approval: `runtimeMode` `full-access`, read with `t3_thread_configuration`. A run inherits the creating thread's provider, model, and runtime settings, so a thread that asks for approval would stall every run on a prompt no one answers. Never change a thread's mode to meet this, and never choose a mode broader than the creating session's; the user reruns the request from a `full-access` thread. A run that hits a permission prompt anyway ends `blocked`, naming the action.
- **Project and binding.** Create the schedule in the repository's own T3 project, the one whose workspace is the repository's main checkout (`t3_project_read`), from a thread in that project, without `projectId`, and bound to that thread (`bindToCurrentThread: true`), so each run posts into it with its settings. From a thread in another project, create nothing and say so.
- **Exact titles.** A schedule's title is exact, and a schedule is matched only by its whole title, never by a substring: `verify-web` must not match `verify-web-admin`.
- **Stopping.** The user stops a schedule by disabling it (`update_scheduled_task` with `enabled: false`, or switching it off in T3's schedule list). A disabled schedule still counts as existing, so nothing recreates or re-enables it. Deleting it (`delete_scheduled_task`) lets a later run recreate it, so delete only when the user asks for deletion by name, and say that first.
- **Fail-safe prompts.** Every stored prompt names the instructions it depends on and a version marker, and tells the run to change nothing and report the schedule obsolete when those instructions are gone or no longer recognize the marker. It repeats the run's core limits, so a run stays safe when the instructions changed under it.
- **No secrets.** No token, key, password, or credential-bearing URL in a title or prompt. The script refuses an origin URL with credentials.
- **Report.** Every creation reports the returned schedule ID, the cadence in words, the returned `nextRunAt`, and how to disable it.

## Known kinds

| Kind | Command | Instructions it depends on |
| --- | --- | --- |
| `upkeep` | `bun <this skill's directory>/scripts/spec.ts upkeep --skill .agents/skills/verify-<app> [--checkout <path>]` | `maintain-verification`'s `## Scheduled runs` section, which must contain the marker `[t3-automation upkeep v1]` |

Run the installed kit's script, `<kit>/skills/t3-automation/scripts/spec.ts`, where `<kit>` is the installed kit: a git checkout of this kit that is detached (no branch checked out) and not a linked worktree. The prompt names that kit's `maintain-verification` file by the kit's real path, `<kit>/skills/maintain-verification/SKILL.md` with any symlink resolved, so a schedule reads the instructions of the checkout the spec came from. The script refuses with exit 1 and the reason when the kit it runs from is not such a checkout (a development checkout on a branch, a linked worktree of this kit, or a copy outside git or below a checkout's root), since a schedule would then read unreviewed instructions every week. The script reads `origin` of the repository at `--checkout` (default the current directory) and accepts only GitHub https and ssh URLs; the prompt names that repository's main checkout, never a T3 worktree. It exits 0 with one JSON object, 1 when a git read or precondition fails (the kit check above fails, the skill is not yet on origin's trunk, or the kit's `maintain-verification` does not recognize the marker, so a schedule would only report itself obsolete), and 2 on a usage error, including a non-GitHub origin.

The JSON is `{kind, version, title, prompt, schedule, bindToCurrentThread, repo}`. The title is `Weekly verification upkeep: <owner/repo> verify-<app>`. The schedule is a weekly `fixed_time` on one weekday between 04:00 and 06:55 local time, derived from the title, so a repository's schedules do not all fire at once. The prompt names the repository to `gh` the way each command takes it, since a bare `gh` in a fork resolves the parent repository: every `gh` command runs with `GH_REPO=<owner/repo>` in its environment (`gh api` fills `{owner}/{repo}` from it; see `gh help environment`), and `gh repo` commands take `<owner/repo>` as their argument.

The script exports what stored prompts depend on (`SCHEDULED_RUNS_HEADING`, `UPKEEP_MARKER`, `UPKEEP_TITLE_PREFIX`, `UPKEEP_BRANCH_PREFIX`, and `recognizesUpkeep`), so a check can hold the depending skill to them. A change that breaks a stored prompt bumps `VERSION`; a schedule holding an older marker then reports itself obsolete unless the depending skill's section still names that marker too.

A kind not in this table has no script yet. With the user's go, write its title and prompt to these rules and show both to the user before creating it; add a kind to the script when a schedule is created more than once.

## Create

Check in order, stopping at the first that fails; report which one and create nothing:

1. The schedule has approval (Rules, Approval).
2. T3's schedule tools are available.
3. This thread is in the repository's own project, and its `runtimeMode` is `full-access`.
4. The spec renders: run the kind's command and read its JSON. A nonzero exit stops here, with the script's error.
5. `list_scheduled_tasks` (no `projectId`) shows no schedule, enabled or disabled, whose title equals the spec's title. If one exists, report its ID, enabled state, and next run, and leave it unchanged.

Then call `schedule_task` without `projectId`, passing the spec's `title`, `prompt`, `schedule` (as an object, never as JSON text), and `bindToCurrentThread` unchanged, and report as Rules, Report says.

## List, disable, delete

- **List:** `list_scheduled_tasks`; report each schedule's ID, title, enabled state, cadence, next run, and last run status.
- **Disable:** on the user's request, `update_scheduled_task` with the schedule's ID and `enabled: false`; read the list back and report the schedule disabled.
- **Delete:** only when the user asks to delete that schedule. Say first that a later run may recreate it, then `delete_scheduled_task` with its ID, and read the list back.

A run that replies that its schedule is obsolete changes nothing; tell the user to disable that schedule by its title, or, to replace it with the current version, to delete it and rerun what creates it.
