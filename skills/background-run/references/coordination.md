# Coordinating several agents

Read before spawning workers for an unattended program. If one agent can finish the work within the run, do not coordinate: run the loop yourself.

## Roles

- **One coordinator** per program. It frames the run, writes briefs, accepts results, and is the only agent that publishes, except an autopilot-full owner, which carries its own pull request through the merge as `babysit-and-ship`'s `autopilot-full.md` defines (see Children).
- **One owner per pull request.** It builds and babysits that PR. A takeover is explicit and recorded in the PR body. In T3, the link enforces it: the coordinator links each PR to its thread (`link_pull_request`) when the PR opens, and before anyone acts on a PR, it checks every active thread's links (`t3_thread_list`, then `list_thread_pull_requests`). A PR linked to another thread belongs to that thread: leave it and report it, unless the user hands it over in their own words.
- **The root is the only writer of branch structure:** rebases, retargets, and stack order. The one exception is an autopilot-full owner rebasing its own branch onto trunk.
- **Verifiers** are fresh agents that did not write the code. A worker may self-report; a verifier's verdict overrides it.

## Children

- Brief each child with its objective, workspace, authority boundary, decisions already made, acceptance check, expected output, and when to stop and escalate.
- Each child works in its own worktree and branch; one writer per checkout.
- Tell each child it does not push, merge, deploy, or post, and do not hand children credentials that could. The exception is an autopilot-full owner, which carries its own pull request through the merge as `babysit-and-ship`'s `autopilot-full.md` defines: it pushes its own `agent/*` branch, opens its pull request after the first push, answers bot threads on it, and merges it only after the coordinator's clean verdict. It never deploys, messages people, or touches another branch or pull request.
- Before every fan-out (owners, verifiers, or reviewers), check the resources the children share, launch only as many as those allow, and queue the rest:
  - **Disk:** before launching verifiers or owners that build containers, check free space where the images land (`docker system df`, `df -h` on Docker's data volume) against the largest past build. A Docker disk at 0 bytes has blocked two verifiers at once; a lane that fails for lack of disk is an infrastructure failure, never a verdict on the change.
  - **Strong-model children:** cap how many children on the strongest model (the `build`, `autopilot-owner`, `review`, and `pr-review` roles) run at once, counting every verification lane, by the usage budget or rate limit they draw on. If the budget cannot be read, the cap is two, and it rises only after a batch reports without hitting a limit; on 2026-10-12 five at once exhausted it.
- Record every child in `children.tsv` (Liveness, below) as it starts.
- Child reports are evidence, not acceptance. Check their artifacts before relying on them.

## Shared state

- Per-run and per-agent files have a single writer. Readers combine them at read time.
- Program state lives in the vendored `orch` store, which locks itself and writes atomically: `agentic orch --store <dir> <command>` (see its `--help`). The verdict ledger's store is `$(git rev-parse --git-common-dir)/agentic/orch`, shared by every worktree. Verdicts go in its ledger, keyed by PR and head SHA, recorded only by a fresh verifier through `agentic verify record` (or, for a countersign, by the coordinator); a new head SHA voids the verdict, and `agentic verify status` right before each merge is the merge gate.

## Liveness

The coordinator keeps `.audit/<task-slug>.children.tsv` beside the decision log, uncommitted, as its only writer. Columns: `ts`, `id` (the child's agent or thread ID), `role`, `item` (the PR or lane), `expected` (minutes: at least the longest past run of that kind, or a stated estimate when there is none), and `state` (`running`, `done`, `stuck`, `failed`, `waiting`, `replaced`). Append a row when a child starts and whenever its state changes, and never edit a row: the latest row for an ID is its state.

A child is stuck when it errored, or when it has run past `expected` with no side effect since the last tick. Stop it before launching its replacement, so a branch never has two writers, and give the replacement a fresh brief that carries the original brief, every later directive, and the stuck child's branch and log. A child waiting on a permission prompt is `waiting`: it is blocked, not running, and its prompt goes to the user.

**Two retries, then replan.** An item whose child failed or stuck twice gets no third child on the same brief: change the approach, split the item, or put it under "Needs you". A stall never counts as proof the work is done or as a reason to drop it.

**Budget.** When the user states a budget for the program (time, usage, or a number of pull requests), stop launching new work at about 70% of it, and spend the rest landing what is verified. Report the items left unstarted.

## Audit tick

For unattended programs, run an audit tick about hourly, on a schedule the harness keeps, never from memory:

- **In T3,** create it with `schedule_task`, bound to the coordinator's thread (`bindToCurrentThread`, an hourly interval), so it runs even when no turn is active. Its prompt names the governing skill's path, the decision log, and `children.tsv`, and says to resume the program from them and run this tick: a stalled program restarts on the next tick once the cause clears. Log its scheduled task ID, report it, and delete it (`delete_scheduled_task`) when the program finishes or the user stops it.
- **Outside T3,** use `/loop` with the same prompt, and say in the report that it dies with the session.

Each tick:

1. Re-read the governing skill, not from memory: from the default branch where the program's repository holds it (`git show origin/<trunk>:<path>`), otherwise from its installed copy.
2. Audit the program against it, and fix drift during the tick.
3. Count only side effects as progress: commits, pushes, PR or check changes, ledger and store rows. A busy transcript is not progress.
4. Run the liveness check over every running row of `children.tsv`, and over the harness's own agent list where it has one. Probe read-only first (store, ledger, branches, the child's log); do not resume an agent just to check on it. Replace each stuck child as Liveness describes, and check the budget.
5. Report each failed or `waiting` child once, in the tick that records it; later ticks repeat it only when its state changes. Never repeat an unchanged ask.
6. Log one decision row per tick.
