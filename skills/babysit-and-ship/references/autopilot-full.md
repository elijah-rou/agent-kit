# Autopilot-full

You own the verdicts, never the PRs. One owner carries each PR from build to merge, and nothing merges without your clean verdict. Use this for a queue of independent changes ("autopilot", "full autopilot", "merge these when they're verified", "land these", "ship it"). Dependent changes are a stack: use `autopilot-stack` or `ship` instead.

## 1. Frame the queue

- List the items. Items the user names as theirs stop at merge-ready: the user reviews and merges them, and no owner does.
- If the user asks for the plan first, state it and stop. Execution starts on the user's go.
- Start a decision log for the program (`show-me-your-work`), with the invocation and the user's words as its first row. The gate in every repository is the local ledger check before each merge (section 4).
- If the user states a budget (time, usage, or a number of PRs), log it: at about 70% of it, launch no new owner and land what is verified (`background-run`'s coordination reference, Liveness).
- Before acting on a PR that already exists, including launching an owner or verifiers for it, check that no other thread owns it (`SKILL.md` section 2): in T3, no other active thread has it linked.
- Arm the audit tick (section 5) before the first owner starts.
- A repository without a verification skill gets one first: the queue's first item is `create-verification`, opened as its first PR. It creates the repository's verification policy, so it lands only by countersign (section 3) and waits at merge-ready under "Needs you" while the other items move; live lanes use a named driver until it merges (`SKILL.md` precondition 2).

## 2. Spawn one owner per PR

Each owner is a child launched with the `autopilot-owner` role, the only child role allowed to publish. Brief it with the item, its worktree and `agent/<topic>` branch off current trunk, and this lifecycle:

1. Build the change in thin verified units, pushing the branch after each one. Open the PR ready for review (not draft) after the first push, with the body from `pr-body.md`, so the URL and checks form a trail early. Its adversarial review comes from the coordinator's verification rounds (section 3), not from a reviewer you spawn.
2. Keep its own decision log (`show-me-your-work`), uncommitted, and return it with its reports. The owner launches no children, so the coordinator's Attention review covers this log.
3. Prove the change on the real artifact with the repository's verification skill, before reporting it code-ready.
4. Rebase onto current trunk once before the code-ready report. After that, rebase again only at merge prep, on a conflict with trunk, or on a CI failure caused by a trunk change. Publish a rebase only to its own branch: first check that `git ls-remote origin <branch>` still shows the head it last pushed (if not, someone else wrote to the branch; stop and report), then push with `git push --force-with-lease=<branch>:<that head>`.
5. Report code-ready with the head SHA. Then babysit to green (sections 2 to 4 of `babysit-and-ship`, waiting with `agentic watch-pr --pr <n>`: as a subagent, the owner cannot hold a T3 watch), and report merge-ready with the head SHA. Where those sections say to report a rebase and stop, or that babysitting never merges, this lifecycle overrides them for the owner's own PR.
6. Never record a verdict, and never merge before you say the verdict is clean.

When an owner reports its PR opened, link the PR to your thread in T3 (`link_pull_request`), so the link records its one owner. Record each owner, and each verifier lane in section 3, in `children.tsv` with its expected runtime as it starts (`background-run`'s coordination reference, Liveness).

Run owners in parallel when their PRs touch disjoint files, and serialize work that genuinely overlaps. Shared resources also bound how many run at once: before every fan-out of owners or verifier lanes, run the fan-out check in `background-run`'s coordination reference (free disk for container builds, a cap on strong-model children counting every lane), and queue the rest. Owners do not stack: sequenced work is merge, then branch.

## 3. Verify every round

A round starts at an owner's code-ready head and at every later push that changes the patch. For each round, spawn fresh verifiers that did not write the code, with these lanes:

- **Live lane (required):** drive the load-bearing behavior on the real surface through the repository's verification skill, or, where the repository has none yet, a named driver: the command or user journey that exercises the change, named in the evidence. A verdict without it is not clean. For a change only to agent instructions or skill text, the live lane is what that skill defines for the case (for example a catalog drive that loads every exported skill, plus a fresh read of the text against the PR's intent), and the evidence says agent behavior was not observed; if the skill defines no such case, the verdict is `verifier-blocked` at best.
- **Regression lane:** run the same scenario on current trunk. If trunk lacks the feature, say so and check the end state the user waits for instead.
- **Audit lane:** run `git-workflow`'s adversarial pull-request review (its `pr-review.md`, through the `pr-review` role where the harness defines one) on the diff against trunk in round 1, and on only what the push changed in a later round, raising only findings that push contains or causes; distrust the PR body either way. This lane is the PR's adversarial review, and every finding carries its class.
- **Second audit lane (when Jev rates the PR high):** run `agentic jev pr-risk <pr>` on the round's head before spawning the lanes. Its result goes in your report and never holds the PR. `not scored` (exit 4: Jev unavailable, a private repository, or withheld text) or a failure is only a note in the report. When it prints `high` (exit 3, a score above its threshold), add a second audit lane with a different question: whether the change crosses a one-way door (a public contract, persisted data, a security boundary, hard-to-reverse architecture) and whether it can be reversed as shipped.

Aggregate the lanes into one verdict; a lane's note about a defect the change contains or causes is a finding, a note marked `out of scope` (a defect the change neither contains nor causes) becomes a follow-up rather than a fix-forward, and a verdict without a passing live lane is `verifier-blocked` at best. You did not write the code, so you record the verdict with `AGENTIC_AGENT_ID` set to your own ID, which the ledger records: `agentic verify record <pr> --verdict <verdict> --evidence <path or URL>`. Nothing is published: the ledger is the gate. Send every proven finding to the owner in one fix-forward, each with its class and the audit lane's `reviewed by` line, and a failing test for each behavior defect where one can show it. The owner records the round in the PR body's `## Review record` (`pr-body.md`): the `reviewed by` line and one line per accepted finding with its class, `fixed` or `open`. The new head gets a fresh round; lane results carry over only where `shipping.md` step 3's patch-ID rule holds. Fix-forwards stop at `shipping.md`'s Review cap: after two re-review rounds past round 1, the PR lands with its remaining notes listed, or the part a blocking finding still holds splits into a follow-up PR, which joins the queue with its own owner.

A PR that sets verification policy (its diff touches a policy path, the list `agentic verify --help` prints, or it deliberately changes an expectation the verification skill asserts; `shipping.md`'s Countersign) is `verifier-blocked` by definition and clean only through a countersign: `record` refuses any other passing verdict for a policy path. When every lane otherwise passes, put it under "Needs you" with its head SHA, its patch ID, the verdict's evidence, and the reason it cannot pass on its own. Once the user approves it in their own words, record `countersigned` with `--patch` naming the patch you showed them and evidence quoting their message; `record` refuses any other patch, and a changed patch needs a new round and new words. Only then tell the owner it is clean.

When an owner reports a new head after a rebase, compute its patch ID yourself (`gh pr diff <pr> | git patch-id --verbatim`) and compare it with the `patch:` suffix of the verdict's ledger row; `agentic verify status` reports `void` for any new SHA and cannot tell you. If the patch is unchanged, carry the verdict to the new SHA: record it again for that head, with evidence naming both SHAs and the shared patch ID (a countersign also with `--patch` naming it). If the patch changed, start a new round.

## 4. The owner merges on your clean verdict

Tell the owner the verdict is clean. Then the owner, and only from a head rebased onto current trunk:

1. Reports the new head SHA after the merge-prep rebase, waits for you to carry the verdict to it (section 3), and waits for CI to pass on it.
2. Notes the full head SHA (`gh pr view <pr> --json headRefOid -q .headRefOid`), then runs `agentic verify status <pr>` with the installed, trunk-built `agentic` (never the CLI in its own worktree), which must exit 0 and print a head matching that SHA's first 12 characters: a passing verdict covers this head and patch. If it does not, report back and wait; never merge on a stale verdict.
3. Fetches trunk and checks that `git merge-tree` against it is clean and that no file trunk changed since the merge base is one the PR changes or one that decides its CI. If either fails, rebase again and repeat from 1.
4. Squash-merges its own PR pinned to the full SHA noted in step 2: `gh pr merge <pr> --squash --match-head-commit <sha>`. If the head moved, the merge fails; go back to step 1. Then it returns.

Step 2 is the only gate, in every repository, public or private: nothing on the forge requires the verdict, so never skip it. A fresh owner takes the next item.

## 5. Keep the program honest

- Run the audit tick in `background-run`'s coordination reference about hourly, on a schedule the harness keeps rather than one you keep in mind. In T3, it is a `schedule_task` bound to your thread, whose prompt says: re-read this file, not from memory (in agent-kit, from trunk: `git show origin/main:skills/babysit-and-ship/references/autopilot-full.md`; elsewhere, the installed skill's copy), resume the program from the decision log and `children.tsv` at their paths, and run the tick. Outside T3, it is `/loop` with that prompt, and your report says it dies with the session. Report the schedule when you create it, and delete it when the queue finishes or the user stops the program.
- Each tick audits the program against this file and fixes drift, counts only side effects as progress (pushes, PR or check changes, ledger rows), and runs the liveness check over every owner and lane: a child past its expected runtime with no side effect, or one that errored, is stopped before its replacement launches, so a branch never has two writers, and an item gets at most two replacements before you replan it. A failed child or one waiting on a permission prompt goes under "Needs you" once, not every tick. A stall never counts as proof the work is done or as a reason to drop it.
- After merges land, sweep the merged PRs for late bot comments and note anything worth a follow-up.
- On the user's stop or hold, every owner stops writing at once and holds its brief until released.
- The always-pause list still holds for owners: no deploys, releases, messages to people, credential changes, or force-pushes to anything but their own branch.

## Reply

The queue with each PR's owner, state, and head SHA; the audit tick's schedule and whether it was deleted; children found stuck, replaced, or waiting on a prompt; each verdict and its lanes; each PR's Jev score and whether it added a second audit lane; what merged, each after its ledger check; countersigns and other items waiting for the user; where the decision logs are.
