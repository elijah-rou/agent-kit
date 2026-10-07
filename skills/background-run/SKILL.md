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

If any fails, say which, and run supervised: the user watches the first iterations. Do not quietly run unattended anyway.

## 2. Frame the run

Before the first iteration, write down:

- **Done predicate:** a check that can pass or fail on the real artifact, such as tests green, zero old callers, the repro fixed, or every listed PR merge-ready. A duration is not a predicate.
- **Scope:** units of work, rough effort, blockers found while grounding, and what is out of scope.
- **Rigor:** the gates each unit passes. A one-way door inside the run goes through `design-checkpoint` before anything depends on it.
- **Authority:** the standing default in the instructions, plus `autopilot-stack` or `ship` only if the user invoked it for this run ("going to bed, land the stack"). `babysit-and-ship` defines both modes and the preconditions to check before relying on one. The invocation gets its own log row with the user's words as evidence and lasts this run only.
- **Workspace:** a fresh worktree off the named base, with one writer.
- **Log:** `.audit/<task-slug>.tsv`, kept as `show-me-your-work` describes, with a first row recording the framing.

Present the framing once. Reversible work proceeds without waiting for an answer.

## 3. Loop

Each iteration:

1. State the hypothesis.
2. Make the smallest change the evidence justifies.
3. Verify against the predicate on the real artifact, not on a self-report.
4. If it advanced the predicate, commit it. If not, discard it; a change that "might help" is reverted, not left in.
5. Append one row to the log.

Waking:

- With an event to watch (CI, a merge, a ref advancing, a process exiting), wait on the event, with a long heartbeat (30 to 60 minutes) as fallback. For pull requests, the event source is `agentic watch-pr` (see its `--help`).
- Without one, use a fixed heartbeat sized to when the result is worth rechecking.
- Use the harness's recurring-loop or workflow facility, or a background command that exits on the event. Never run a second sleep loop beside the watcher.

Steering:

- A plateau means change the approach, not stop.
- After two fixes built on the same premise fail the same gate, question the premise. Flag the area as a hard part for the user and do not make a third attempt on that premise.
- Fix reversible discoveries yourself (broken tooling, flaky checks, related bugs) in separate commits, then return to the predicate.
- Never relax the predicate to declare victory. If the predicate itself is wrong, stop and report why.

## 4. Hard points

The instructions' always-pause list holds in every mode: destructive actions, deploys and releases, messages to people, credential or permission changes, and anything outside the repository. Those items, and anything a permission prompt, guard, or forge rule blocks or asks about, wait for the user under "Needs you" while reversible work continues. Draft any message to a person in the report. A block is final; never route around it.

## 5. Finish

When the predicate holds, verify the whole result on the real product, not only the harness. Audit the log against this run's transcript and get the cross-model Attention review as the `show-me-your-work` skill describes. At a genuine dead end, stop and write up why, rather than reinterpreting the goal.

## Reply

"Needs you" first: decisions, blocked actions waiting on the user, hard parts flagged, drafted messages to people. Then the predicate and its final state, iterations run, what landed and what was discarded, the log path, and the `Attention` section.
