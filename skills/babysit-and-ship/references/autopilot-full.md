# Autopilot-full

You own the verdicts, never the PRs. One owner carries each PR from build to merge, and nothing merges without your clean verdict. Use this for a queue of independent changes ("full autopilot", "autopilot this queue"). Dependent changes are a stack: use `autopilot-stack` or `ship` instead.

## 1. Frame the queue

- List the items. Items the user names as theirs stop at merge-ready: the user reviews and merges them, and no owner does.
- If the user asks for the plan first, state it and stop. Execution starts on the user's go.
- Start a decision log for the program (`show-me-your-work`), with the invocation and the user's words as its first row, and which gate holds each repository: `merge-gate`, or local in a private repository.

## 2. Spawn one owner per PR

Each owner is a child launched with the `autopilot-owner` role, the only child role the harness's guards let publish. Brief it with the item, its worktree and `agent/<topic>` branch off current trunk, and this lifecycle:

1. Build the change in thin verified units, pushing the branch after each one. Open the PR ready for review (not draft) after the first push, with the body from `pr-body.md`, so the URL and checks form a trail early.
2. Keep its own decision log (`show-me-your-work`), uncommitted, and return it with its reports.
3. Prove the change on the real artifact with the repository's verification skill, before reporting it code-ready.
4. Rebase onto current trunk once before the code-ready report. After that, rebase again only at merge prep, on a conflict with trunk, or on a CI failure caused by a trunk change. Publish a rebase only to its own branch: first check that `git ls-remote origin <branch>` still shows the head it last pushed (if not, someone else wrote to the branch; stop and report), then push with `git push --force-with-lease=<branch>:<that head>`.
5. Report code-ready with the head SHA. Then babysit to green (sections 2 to 4 of `babysit-and-ship`, with `agentic watch-pr --pr <n>`), and report merge-ready with the head SHA. Where those sections say to report a rebase and stop, or that babysitting never merges, this lifecycle overrides them for the owner's own PR.
6. Never record or publish a verdict, and never merge before you say the verdict is clean.

Run owners in parallel when their PRs touch disjoint files; serialize only work that genuinely overlaps. Owners do not stack: sequenced work is merge, then branch.

## 3. Verify every round

A round starts at an owner's code-ready head and at every later push that changes the patch. For each round, spawn fresh verifiers that did not write the code, preferably on a different model family, with these lanes:

- **Live lane (required):** drive the load-bearing behavior on the real surface through the repository's verification skill. A verdict without it is not clean.
- **Regression lane:** run the same scenario on current trunk. If trunk lacks the feature, say so and check the end state the user waits for instead.
- **Audit lane:** read the diff against trunk, distrusting the PR body: callers, data and configuration safety, races.

Aggregate the lanes into one verdict; a lane's note about a defect is a finding, and a verdict without a passing live lane is `verifier-blocked` at best. In a public repository, run `agentic jev pr-risk <pr>` on the round's head before publishing: a hold makes the PR the user's: still record and publish its verdict so the user can merge it, but never tell the owner it is clean; it stops at merge-ready and goes under "Needs you" with the score. You did not write the code, so you record the verdict: `agentic verify record <pr> --verdict <verdict> --evidence <path or URL>`, then `agentic verify publish <pr>`. Send every proven finding to the owner in one fix-forward, with a failing test for each behavior defect where one can show it. The new head gets a fresh round; lane results carry over only where `shipping.md` step 3's patch-ID rule holds.

When an owner reports a new head after a rebase, compute its patch ID yourself (`gh pr diff <pr> | git patch-id --stable`) and compare it with the `patch:` suffix of the verdict's ledger row; `agentic verify status` reports `void` for any new SHA and cannot tell you. If the patch is unchanged, carry the verdict to the new SHA: record it again for that head, with evidence naming both SHAs and the shared patch ID, and publish it. If the patch changed, start a new round.

## 4. The owner merges on your clean verdict

Tell the owner the verdict is clean. Then the owner, and only from a head rebased onto current trunk:

1. Reports the new head SHA after the merge-prep rebase, waits for you to carry the verdict to it (section 3), and waits for CI to pass on it.
2. Notes the full head SHA (`gh pr view <pr> --json headRefOid -q .headRefOid`), then runs `agentic verify status <pr>`, which must exit 0 and print the same head: the verdict covers this head and patch, and the forge agrees. If it does not, report back and wait; never merge on a stale verdict.
3. Fetches trunk and checks that `git merge-tree` against it is clean and that no file trunk changed since the merge base is one the PR changes or one that decides its CI. If either fails, rebase again and repeat from 1.
4. Squash-merges its own PR pinned to the full SHA noted in step 2: `gh pr merge <pr> --squash --match-head-commit <sha>`. If the head moved, the merge fails; go back to step 1. Then it returns.

In a `merge-gate` repository the forge refuses the merge without the verdict status anyway; in a private repository step 2 is the only gate, so never skip it. A fresh owner takes the next item.

## 5. Keep the program honest

- Run an audit tick about hourly with the harness's recurring facility, never from memory: re-read this file from trunk, audit the program against it, and count only side effects as progress (pushes, PR or check changes, ledger rows). Stop an owner with no side effect since the last tick before launching its replacement, so a branch never has two writers. A stall never counts as proof the work is done or as a reason to drop it.
- After merges land, sweep the merged PRs for late bot comments and note anything worth a follow-up.
- On the user's stop or hold, every owner stops writing at once and holds its brief until released.
- The always-pause list still holds for owners: no deploys, releases, messages to people, credential changes, or force-pushes to anything but their own branch.

## Reply

The queue with each PR's owner, state, and head SHA; each verdict and its lanes; what merged and which gate held it (`merge-gate` or local); Jev holds and other items waiting for the user; where the decision logs are.
