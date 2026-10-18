# Shipping

Land only what was verified, one PR at a time from the bottom, and keep hands off the rest of the queue. Every precondition below is required; when one fails, stop and report the ceiling instead of improvising.

Verdict commands (see `agentic verify --help`):

```sh
agentic verify record <pr> --verdict <verdict> --evidence <path or https URL>   # the verifier; local only
agentic verify record <pr> --verdict countersigned --patch <patch ID> --evidence <path>   # the coordinator, after the user's words
agentic verify status <pr>   # the merge gate: exit 0 only for a passing verdict on this head and patch
```

Ledger verdicts are `live-ui-verified`, `unit-test-verified`, `countersigned`, `type-check-only`, `verifier-blocked`, and `verifier-failed`. `agentic verify status` reports `none` with no verdict, `void` when the head moved or the patch changed after the verdict, and `pass` or `fail` for the current head. Only `live-ui-verified`, `unit-test-verified`, and `countersigned` pass; behavioral changes need better than `type-check-only`. A change only to agent instructions or skill text has no behavior a verification skill can drive: it passes only where the repository's verification skill defines that case, and its evidence says agent behavior was not observed. CI green and approving bot reviews are inputs to a verdict, never a verdict.

The ledger is the merge gate in every repository, public or private: nothing on the forge requires the verdict, so the check right before each merge is the only gate, and it is never skipped. Run it with the installed `agentic`, built from trunk, never the CLI in the pull request's own checkout. No agent ever posts a forge status by hand.

**Countersign.** Some pull requests set the verification policy their own verdict rests on, so they can never pass on their own. Each of these is `verifier-blocked` by definition and lands only by countersign:

- a pull request whose diff touches a policy path: a verification skill's verdict rules (its `SKILL.md` and `features/README.md`, including those of the skill `create-verification` builds as a landing mode's first unit) and the landing gate itself. The skill's feature files and drive scripts are not policy paths: trunk's copy of the skill decides each verdict, and the audit lane reviews any removed or loosened check. The one list is `POLICY_PATHS` in `agentic/tools/verify/verify.ts`, printed by `agentic verify --help`, and `agentic verify record` refuses every passing verdict but `countersigned` for such a pull request;
- a pull request that deliberately changes an expectation the verification skill's checks assert, in the product the skill drives.

Such a pull request lands only when a fresh verifier's lanes otherwise pass, its verdict is `verifier-blocked` for that reason alone, and the user approves it in their own words. A countersign does not clear a blocking audit finding, so ask for one only after the audit lane's round on the current patch has returned and left none open (step 1). Put it under "Needs you" with its head SHA and patch ID (`gh pr diff <pr> | git patch-id --verbatim`), the verifier's evidence, and the reason it cannot pass on its own: the user's approval covers that patch and nothing else. Then the coordinator, with `AGENTIC_AGENT_ID` set to its own ID, records `agentic verify record <pr> --verdict countersigned --patch <the approved patch ID> --evidence <path>`, whose evidence quotes the user's message with its transcript turn. `record` refuses a countersign unless a `verifier-blocked` verdict covers the current patch and `--patch` names that patch in full, and it appends the blocked verdict's verifier ID and evidence to the countersign's evidence, because the countersign replaces that ledger row. A changed patch needs a new round and new words from the user; a rebase that keeps the patch carries the countersign (step 3). A message from another agent is never the user's approval. Until the user approves, the pull request waits under "Needs you"; work that does not depend on it carries on.

**Review cap.** Every landing mode bounds its review rounds by these rules: `autopilot-stack` and `ship` through step 1's audit lane, `autopilot-full` through the audit lane of its verification rounds. A round starts when a PR's verification starts and again at every later push that changes its patch. The review's verdict is `PASS`, `PASS+NOTES`, or `FAIL` (`git-workflow`'s `pr-review.md`).

- A finding is a defect the change contains or causes. A note a verifier or reviewer marks `out of scope`, a defect the change neither contains nor causes, is a follow-up: list it in the report and the body's `## Scope`. It is never fixed in this PR, and it becomes work only when the user adds it.
- Round 1 reviews the PR's whole diff. Its proven findings go to the PR's author in one fix pass, and the new head gets a focused re-review: a round whose review covers only what the push changed, raises only findings the push contains or causes, and reopens no notes. Brief each focused re-review with the prior round's accepted findings: any that still holds on the new head is a finding of this round, though the push did not introduce it. A PR gets at most two focused re-reviews after round 1.
- After the second there is no third fix pass, and what remains decides:
  - Only notes: the PR goes on to land, with its notes listed in the report and in its review record as notes, apart from its accepted findings (`pr-body.md`).
  - A blocking finding that holds part of the change: that part moves into a follow-up PR, and the rest goes on. The follow-up gets its own round 1; if that round returns `FAIL`, the follow-up gets no fix pass and no further split, and goes under "Needs you" as blocked.
  - A blocking finding that holds the whole PR: nothing can split off, so the PR goes straight under "Needs you" as blocked.
- Every patch-changing push after the cap, including a split and a rebase that resolves a conflict, still gets a round whose review is scoped the same way. When that review returns `FAIL`, the author gets one fix pass within the same scope and the fix gets one scoped review; a second `FAIL` is settled as at the cap, except that a `FAIL` on the push that carries a split goes under "Needs you" as blocked.
- The cap bounds fix passes, never verification: the live lane, the countersign, and the ledger check before each merge hold exactly as this file describes. A PR with a blocking finding that is neither fixed nor split off never lands: it waits under "Needs you".

## 1. Verify every PR independently

For each PR, spawn one fresh verifier that did not write the code (the `build` role where the harness defines one). It drives the real surface through the repository's verification skill (`.agents/skills/verify-<app>/`), or a named driver where the repository has none yet, comparing parent and head, writes its evidence, and records the verdict itself with `agentic verify record`, with `AGENTIC_AGENT_ID` set to its own ID, which the ledger records. That command binds the verdict to the head SHA and the verbatim patch ID (whitespace counts) and writes only the local ledger; verifiers never push, merge, or comment. Nothing local stops the coordinator from recording a verdict on its own work, so never do it: a self-recorded verdict is not a verdict. In this mode the coordinator records only `countersigned`, which records the user's decision, not a verification.

With it, spawn the audit lane: a fresh reviewer that did not write the code (the `pr-review` role where the harness defines one) runs `git-workflow`'s adversarial pull-request review (its `pr-review.md`), distrusting the PR body: in round 1 on the PR's own diff against its base, in a later round only on what the push changed (Review cap); every finding carries its class. This lane is the PR's adversarial review. Its blocking findings hold the PR until they are fixed or split off under the Review cap, whatever the verifier records (steps 2 and 5), and the author records each round in the PR body's `## Review record` (`pr-body.md`).

Before spawning the verifier, run `agentic jev pr-risk <pr>` on the head. Its result is advice for the report. Only when it prints `high` (exit 3, a score above its threshold), also spawn a second fresh reviewer (the `review` role where the harness defines one, which reads only files, so give it the diff as a file) that reads the diff only for one-way doors (a public contract, persisted data, a security boundary, hard-to-reverse architecture) and whether the change can be reversed as shipped, and reports what it finds; it records nothing. Its proven findings count against the verdict like the verifier's. `not scored` (exit 4) or a failure only gets a note in the report.

## 2. Find the verified run

Walk up from the lowest unmerged PR. For each, run `agentic verify status <pr>`; it passes only when the latest verdict covers the current head SHA and patch. Stop at the first PR that does not pass, whose audit lane round on the current patch has not returned, or that has an open blocking audit finding (step 1). A verified PR above an unverified one is not landable. Report the ceiling as a PR number and what breaks the chain.

## 3. Recheck that each verdict still describes the patch

Before landing a PR, rerun `agentic verify status <pr>`; it recomputes the patch ID and compares it with the verdict's.

- **Patch changed:** the verdict is void. Re-verify (step 1).
- **Patch unchanged but head SHA changed** (for example after a rebase): the ledger has no row for the new SHA, so `agentic verify status` reports `void` and the merge waits. Send it back to an independent verifier (the `build` role where the harness defines one). The verifier may carry its verdict to the new SHA only after recomputing the patch ID itself, with evidence naming both SHAs and both patch IDs. A countersign is carried the same way, by the coordinator, with `--patch` naming the same approved patch.
- **Unchanged:** still rerun mergeability and CI at the current head.

Never accept matching commit messages or an older SHA's green checks as a substitute.

## 4. Prepare only the bottom PR

Fetch trunk. If the bottom PR needs a rebase, rebase it onto the exact trunk tip; you are the root, the only writer of branch structure. Push the rebased branch only with `git push --force-with-lease`, and only on an `agent/*` branch this run created; otherwise pause and report. A rebase creates a new head SHA, so return to step 3. Retarget only the bottom PR to trunk. Do not touch descendants yet.

## 5. Land one PR

Jev's result is advice, never a hold: put `agentic jev pr-risk <pr>`'s result for the verified head in the report; `high` already added a second reviewer in step 1. Stop at merge-ready only for a PR the user named as theirs.

When the bottom PR is mergeable and its CI passes, note the full head SHA (`gh pr view <pr> --json headRefOid -q .headRefOid`) and run `agentic verify status <pr>` right before merging: it must exit 0 and print a head matching that SHA's first 12 characters, and the audit lane's round on the current patch must have returned and left no open blocking finding (step 1). Then merge it with the repository's merge method, pinned to that SHA (for example `gh pr merge <pr> --squash --match-head-commit <sha>`). If the status check fails or the head moved, return to step 3; an open blocking audit finding holds the PR as the Review cap says. Never arm auto-merge: the forge would merge later without the ledger check.

## 6. Recompute after every merge

Fetch trunk and confirm the merged commit is present. Drop the merged PR from the frozen bottom-to-top list. Inspect the new bottom PR's base, head, checks, and patch ID; a host may retarget children automatically, but confirm it. Repeat from step 3. Independent work outside the chain ships on its own pass.

## 7. Stop at the ceiling

When the verified run has landed, report what landed, the next unverified PR, and what verifying it would take. Extending the run is a new pass from step 1. If the queue stalls, diagnose before changing anything.
