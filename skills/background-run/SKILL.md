---
name: background-run
description: Run long or unattended work to a falsifiable done predicate. Frame the run first, wake on events with a long heartbeat fallback, make the smallest justified change per iteration, commit or discard it, log every iteration, and pause or resume safely. Use when the user hands off work to run unattended ("going to bed, keep going", "run until done"), or asks to pause or pick up such a run.
disable-model-invocation: true
---

# Background run

You own the exit condition. Define done, then drive to it without waiting on the user, inside the authority the run has.

When the user asks to pause, or to pick up a previous run, read `references/pause-and-pickup.md` and follow it instead of the loop below. "Keep going" never means pause. For a program with several agents, also read `references/coordination.md` before the first spawn.

## 1. Earn trust before the loop

Run unattended only when all four hold:

1. The task has been done once by hand, or watched while an agent did it, so good is known.
2. The agent has the tools and signals the user would use: the repository's verification skill, profilers, logs.
3. Every stage proves its work and can stop the line when the work misses the bar.
4. Repeated failures from earlier transcripts have become checks, tools, or skills.

Record the check so it leaves a trace: it is the first row this run writes to the log section 2 names (`show-me-your-work`), preceded only by a `start` row or the row quoting a mode the user invoked. Phase `trust`; `decision` is `unattended` or `supervised`; `why` takes each condition by number as held or failed, with the fact that decides it; `evidence` gives a pointer per condition, such as a past run's log, the verification skill's path, a check's command, or a transcript turn; `result` is `4 of 4 held` or names the failed conditions. A condition with no evidence failed.

If any fails, say which, and run supervised: the user watches the first iterations. Do not quietly run unattended anyway.

## 2. Frame the run

Before the first iteration, write down:

- **Done predicate:** a check that can pass or fail on the real artifact, such as tests green, zero old callers, the repro fixed, or every listed PR merge-ready. A duration is not a predicate.
- **Scope:** units of work, rough effort, blockers found while grounding, and what is out of scope.
- **Rigor:** the gates each unit passes. A one-way door inside the run goes through `design-checkpoint` before anything depends on it.
- **Authority:** the standing default in the instructions, plus `autopilot-stack`, `ship`, or `autopilot-full` only if the user invoked it for this run ("going to bed, land the stack"). `babysit-and-ship` defines the three modes and the preconditions to check before relying on one. The invocation gets its own log row with the user's words as evidence and lasts this run only.
- **Workspace:** a fresh worktree off the named base, with one writer.
- **Log:** `.audit/<task-slug>.tsv`, kept as `show-me-your-work` describes, with the trust row from section 1 and then a row recording the framing.

Present the framing once. Reversible work proceeds without waiting for an answer.

## 3. Loop

Each iteration:

1. State the hypothesis.
2. Make the smallest change the evidence justifies.
3. Verify against the predicate on the real artifact, not on a self-report.
4. If it advanced the predicate, commit it. If not, discard it; a change that "might help" is reverted, not left in.
5. Append one row to the log.

Waking:

- With an event to watch (CI, a merge, a ref advancing, a process exiting), wait on the event, with a long heartbeat (30 to 60 minutes) as fallback. For a pull request, the event source in a T3 thread is `watch_pull_request`, this run's own watch (`babysit-and-ship` section 4), which wakes the thread on a failed check, passing required checks, a new comment or review, or a conflict. A subagent cannot hold that watch; there, and outside T3, use `agentic watch-pr` (see its `--help`).
- Without one, use a fixed heartbeat sized to when the result is worth rechecking.
- Keep the heartbeat on a schedule the harness keeps. In T3, that is a `schedule_task` bound to this thread, whose prompt resumes the run from the decision log, so a stalled run restarts on the next beat once the cause clears. Outside T3, use the harness's recurring facility (`/loop` where the harness has it) or a background command that exits on the event, and say in the framing that it dies with the session; in a harness with neither, say in the framing that the heartbeat cannot be armed. Never run a second sleep loop beside the watcher.
- The heartbeat dies with this session (an auth failure, a usage or session limit), and nothing inside an agent can report that. So arming the heartbeat also registers the run with the watchdog, a script that a timer outside any agent runs (`watchdog.ts scan`). A run counts as watched only where such a timer runs `scan` every 15 minutes; an install of this kit that wants watched runs sets that timer up. `scan` notifies the user once when the decision log has had no new row for twice the interval plus 15 minutes, or when the log goes missing. Every beat therefore logs a row, phase `beat` when it has nothing else to log. Pick the run ID once, from the task slug and the date (`<task-slug>-<YYYY-MM-DD>`), so it is unique on this machine; re-arming and a later pickup reuse it. Register with the heartbeat's interval and the log's absolute path, then read `status`, and log both outputs:

  ```sh
  bun <this skill's directory>/scripts/watchdog.ts register --run <run ID> --log <absolute path of the decision log> --interval-minutes <heartbeat minutes> --title "<run name>" [--thread <T3 thread ID>]
  bun <this skill's directory>/scripts/watchdog.ts status --run <run ID>
  ```

  `register` exits 1 and names the reason. When it says another decision log holds the run ID, that is another run: pick another ID, and pass `--replace` only when the registration is this run's own. Any other failure leaves the run unregistered, which `status` then shows. In the report, state `watched, last scan <time>` only when the `last-scan` line of `status` reads `fresh` and this run's line reads `registered`. Otherwise state `not watched` and why: `stale scan` (`last-scan` reads `stale`: no scan for over 30 minutes, twice the 15-minute interval, so the timer has stopped), `never scanned` (it reads `never`: no timer has scanned this machine), or `unregistered` (this run's line reads `unregistered` or `invalid`). Nothing outside the session watches such a run.
- The heartbeat, the watch, and the watchdog registration belong to the run: when the run stops, whether the predicate holds, it stops at a dead end or at a budget the user set, or the user says stop, hold, or pause, log the stop as a row, remove the heartbeat and the watch, and unregister the run in the same step (`bun <this skill's directory>/scripts/watchdog.ts unregister --run <run ID>`). Each beat first reads the log for such a row after the newest row whose phase is `start` or `resume` (the whole log when it has neither), so a stop the user has since resumed from does not count, and, finding one, removes itself, unregisters the run, and does nothing else. Resuming takes the user's words, logged as a row with phase `resume`, then a new heartbeat and a new registration.

Steering:

- A plateau means change the approach, not stop.
- After two fixes built on the same premise fail the same gate, question the premise. Flag the area as a hard part for the user and do not make a third attempt on that premise.
- Fix reversible discoveries yourself (broken tooling, flaky checks, related bugs) in separate commits, then return to the predicate.
- Never relax the predicate to declare victory. If the predicate itself is wrong, stop and report why.

## 4. Hard points

The instructions' always-pause list holds in every mode: destructive actions, deploys and releases, messages to people, credential or permission changes, and anything outside the repository. Those items, and anything a permission prompt, guard, or forge rule blocks or asks about, wait for the user under "Needs you" while reversible work continues. Draft any message to a person in the report. A block is final; never route around it.

## 5. Finish

When the predicate holds, verify the whole result on the real product, not only the harness. Audit the log against this run's transcript and get the Attention review as the `show-me-your-work` skill describes. At a genuine dead end, stop and write up why, rather than reinterpreting the goal.

## Reply

"Needs you" first: decisions, blocked actions waiting on the user, hard parts flagged, drafted messages to people. Then the predicate and its final state, iterations run, what landed and what was discarded, the log path, and the `Attention` section.
