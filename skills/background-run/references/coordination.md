# Coordinating several agents

Read before spawning workers for an unattended program. If one agent can finish the work within the run, do not coordinate: run the loop yourself.

## Roles

- **One coordinator** per program. It frames the run, writes briefs, accepts results, and is the only agent that publishes, except an autopilot-full owner, which carries its own pull request through the merge as `babysit-and-ship`'s `autopilot-full.md` defines (see Children).
- **One owner per pull request.** It builds and babysits that PR. A takeover is explicit and recorded in the PR body. In T3, the thread link is the owner record (`babysit-and-ship` section 2): the coordinator links each PR to its thread (`link_pull_request`) when the PR opens.
- **The root is the only writer of branch structure:** rebases, retargets, and stack order. The one exception is an autopilot-full owner rebasing its own branch onto trunk.
- **Verifiers** are fresh agents that did not write the code. A worker may self-report; a verifier's verdict overrides it.

## Children

- Brief each child with its objective, workspace, authority boundary, decisions already made, acceptance check, expected output, and when to stop and escalate.
- Each child works in its own worktree and branch; one writer per checkout.
- Tell each child it does not push, merge, deploy, or post, and do not hand children credentials that could. The exception is an autopilot-full owner, which carries its own pull request through the merge as `babysit-and-ship`'s `autopilot-full.md` defines: it pushes its own `agent/*` branch, opens its pull request after the first push, answers bot threads on it, and merges it only after the coordinator's clean verdict. It never deploys, messages people, or touches another branch or pull request.
- Before every fan-out (owners, verifiers, or reviewers), check the resources the children share, launch only as many as those allow, and queue the rest:
  - **Disk:** before launching verifiers or owners that build containers, check free space where the images land (`docker system df`, `df -h` on Docker's data volume) against the largest past build. A Docker disk at 0 bytes has blocked two verifiers at once; a lane that fails for lack of disk is an infrastructure failure, never a verdict on the change.
  - **Strong-model children:** cap how many children on the strongest model (the `build`, `autopilot-owner`, `review`, and `pr-review` roles) work at once, counting every verification lane, by the usage budget or rate limit they draw on. A child that is `idle` (Liveness) draws on nothing and does not count, so owners waiting on their verdicts never starve the lanes that verify them. If the budget cannot be read, the cap is two, and it rises only after a batch reports without hitting a limit; on 2026-10-12 five at once exhausted it.
- Record every child in `children.tsv` (Liveness, below) as it starts.
- Child reports are evidence, not acceptance. Check their artifacts before relying on them.

## Shared state

- Per-run and per-agent files have a single writer. Readers combine them at read time.
- Program state lives in the vendored `orch` store, which locks itself and writes atomically: `agentic orch --store <dir> <command>` (see its `--help`). The verdict ledger's store is `$(git rev-parse --git-common-dir)/agentic/orch`, shared by every worktree. Verdicts go in its ledger, keyed by PR and head SHA, recorded only by a fresh verifier through `agentic verify record` (or, for a countersign, by the coordinator); a new head SHA voids the verdict, and `agentic verify status` right before each merge is the merge gate.

## Liveness

The coordinator keeps `.audit/<task-slug>.children.tsv` beside the decision log, uncommitted, as its only writer. Columns: `ts`, `id` (the child's agent or thread ID, or `run` for the program itself), `role`, `item` (the PR or lane), `expected` (minutes: at least the longest past run of that kind, or a stated estimate when there is none), and `state`. Append a row when a child starts and whenever a state changes, and never edit a row: the latest row for an ID is its state.

A child's state is one of:

- `running`: working on its brief.
- `idle`: it reported and waits on the coordinator, such as an owner waiting for a verdict or for the word that it is clean. Liveness never replaces it, and it does not count toward the fan-out cap.
- `waiting`: it sits on a permission prompt. `blocked`: it returned because a permission prompt, guard, or forge rule refused an action. Both go under "Needs you" with the prompt or the refused action, and neither is ever replaced or relaunched on the same brief: a new child would meet the same refusal.
- `stuck`: it errored, or ran past `expected` with no side effect since the last tick. `failed`: it returned without its deliverable for any other reason.
- `held`: the run is held, and the child stopped writing and keeps its brief.
- `done` or `replaced`.

**Replace, then replan.** A `stuck` or `failed` child is the one kind that is replaced. Stop it first, so a branch never has two writers, and give the replacement a fresh brief that carries the original brief, every later directive, and the old child's report, branch, and log. An item gets its original child plus at most two replacements; when the second replacement also ends `stuck` or `failed`, it gets no further child on the same brief: change the approach, split the item, or put it under "Needs you". A stall never counts as proof the work is done or as a reason to drop it.

**The run's own state.** The `run` row is `running`, `held` when the user says stop, hold, or pause (every child stops writing at once and is recorded `held`), `paused` when the run stops itself at a dead end, at the end of its budget, or after three audit ticks without progress (Audit tick, step 8), or `done` when the program finishes. Only the user's own words move a `held` or `paused` run back to `running`.

**Budget.** When the user states a budget for the program (time, usage, or a number of pull requests), stop launching new work at about 70% of it, and spend the rest landing what is verified. When it runs out, the run is `paused`. Report the items left unstarted.

## Audit tick

For unattended programs, run an audit tick about hourly, on a schedule the harness keeps, never from memory:

- **In T3,** create it with `schedule_task`, bound to the coordinator's thread (`bindToCurrentThread`, an hourly interval), so it runs even when no turn is active. Its prompt names the governing skill's path, the decision log, and `children.tsv`, and says to resume the program from them and run this tick: a stalled program restarts on the next tick once the cause clears. Log its scheduled task ID and report it.
- **Outside T3,** use the harness's recurring facility (`/loop` where the harness has it) with the same prompt, and say in the report that it dies with the session. In a harness with none, say in the report that the tick cannot be armed, so nothing restarts a stalled program.
- **The watchdog.** The tick dies with the coordinator's session (an auth failure, a usage or session limit), and nothing inside an agent can report that. So arming the tick also registers the run with the watchdog, a script that a timer outside any agent runs (`watchdog.ts scan`): it notifies the user once when the decision log has no new row for twice the interval plus a grace period, or when the log goes missing. Use the installed kit's copy, with the tick's interval in minutes and the log's absolute path, and log the output:

  ```sh
  bun ~/.local/share/bootstrap/tools/agent-kit/skills/background-run/scripts/watchdog.ts register --run <task-slug> --log <absolute path of the decision log> --interval-minutes 60 --title "<program name>" [--thread <T3 thread ID>]
  ```

  If that path does not exist, or no timer on this machine runs `scan`, say in the report that nothing outside the session watches the run.

The tick and the watchdog registration belong to the run: as soon as the `run` row leaves `running`, whether the program is `done`, `held`, or `paused`, delete the tick (`delete_scheduled_task`, or end the loop) and unregister the run in the same step, so every exit that deletes the tick unregisters it:

```sh
bun ~/.local/share/bootstrap/tools/agent-kit/skills/background-run/scripts/watchdog.ts unregister --run <task-slug>
```

Resuming a `held` or `paused` run takes the user's words, which re-arm both: a new tick and a new registration.

Each tick:

1. Read the `run` row first. Unless it is `running`, launch, replace, and resume nothing, delete this tick if it still exists, unregister the watchdog, and end.
2. Re-read the governing skill, not from memory: from the default branch where the program's repository holds it (`git show origin/<trunk>:<path>`), otherwise from its installed copy.
3. Audit the program against it, and fix drift during the tick.
4. Count only side effects since the previous tick's row as progress: commits, pushes, PR or check changes, ledger and store rows. A busy transcript is not progress.
5. Run the liveness check over every `running` row of `children.tsv`, and over the harness's own agent list where it has one. Probe read-only first (store, ledger, branches, the child's log); do not resume an agent just to check on it. Replace or report each child as Liveness describes, and check the budget.
6. Report each `waiting` or `blocked` child, and each item out of replacements, once, in the tick that records it; later ticks repeat it only when its state changes. Never repeat an unchanged ask.
7. Log one decision row per tick, with phase `tick` and a `result` that starts with `progress` or `no progress` by step 4's count.
8. **Stop after three ticks without progress.** Read the decision log, never memory: if this tick's row and the two `tick` rows before it all start `no progress`, the run pauses itself. Append the `run` row to `children.tsv` as `paused`; log a row with phase `pause`, result `paused`, and a `why` naming the reason (three ticks without side-effect progress, and what the run waits on); delete this tick; unregister the watchdog; send one notification, then end:

   ```sh
   bun ~/.local/share/bootstrap/tools/agent-kit/skills/background-run/scripts/watchdog.ts notify --run <task-slug> --message "<program name> paused: three ticks without progress; <what it waits on>"
   ```

   That notification is the run's one ask. Only the user's words resume the run, and they re-arm the tick and the watchdog.
