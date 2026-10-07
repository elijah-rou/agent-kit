# Pause and pickup

## Pause safely

Pause only on an explicit request ("pause", "I'm going offline", "about to restart"). "Keep going" and "don't stop" never pause.

1. **Stop at a safe boundary.** Finish the current atomic step or back out of it. Start nothing new. Cancel running subagents and record what each was doing.
2. **Take no irreversible action to pause.** No new push or pull request unless one was already out.
3. **Make the work durable.** Commit uncommitted edits as one `wip:` commit on the current branch. If the tree is broken, say so in one line of the commit body.
4. **Write the resume note** to `.audit/<task-slug>.resume.md` beside the decision log, uncommitted: the goal and done predicate, what you were doing, progress and what is verified, current state (branch, worktree, base, open PRs), next steps, key files, gotchas, and the authority in effect (level, and any session raise). Point to the decision log instead of repeating it.
5. **Log the pause:** `agentic decision-log append <log> pause <what stopped> <why> <resume note path> paused`.

**Reply:** where you are in the loop, what is on disk versus only in your head, the commits made and whether the tree is clean, and the first action on resume. This is a pause, not a final report.

## Session pickup

The prior trail is authoritative input. Read it; do not redo it.

1. **Locate the trail:** the resume note, the decision log, a pushed branch, and the prior transcript in this workspace only. Never read other projects' transcripts. Parse a long transcript in a read-only subagent and keep only the reduced timeline.
2. **Start your run in the log:** `agentic decision-log start <log> <run-id>`.
3. **Reconstruct state:** branch and worktree, what landed (`git log` and `git diff` against the base), open work, decisions made, and the authority in effect. A session raise from the prior run does not carry over unless the user restates it.
4. **Diff done against pending.** Name the resume point. Do not rerun the prior reproduction or redo finished work.
5. **Verify inherited claims** against the done predicate on the real artifact. A passing self-report from the prior run is not proof.
6. **Continue** with the loop in the skill, or, if the prior run was finished, ratify or override its conclusion, or write a short postmortem of a failed run.

**Reply:** where the prior agent stopped, what you inherited versus redid (ideally nothing redone), the resume point, and the outcome.
