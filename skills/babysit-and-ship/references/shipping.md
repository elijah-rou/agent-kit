# Shipping at A4

Land only what was verified, one PR at a time from the bottom, and keep hands off the rest of the queue. Every precondition below is required; when one fails, stop and report the ceiling instead of improvising.

Verdict commands (see `agentic verify --help`):

```sh
agentic verify record <pr> --verdict <verdict> --evidence <path or https URL>
agentic verify status <pr>
```

Ledger verdicts are `live-ui-verified`, `unit-test-verified`, `type-check-only`, `verifier-blocked`, and `verifier-failed`. `agentic verify status` reports `none` with no verdict, `void` when the head moved after the verdict, and `pass` or `fail` for the current head. Only `live-ui-verified` and `unit-test-verified` pass; behavioral changes need better than `type-check-only`. CI green and approving bot reviews are inputs to a verdict, never a verdict.

## 1. Verify every PR independently

For each PR, spawn one verifier that did not write the code, preferably on a different model family. It drives the real surface through the repository's verification skill (`.agents/skills/verify-<app>/`), comparing parent and head, writes its evidence, and records the verdict itself with `agentic verify record`. That command binds the verdict to the head SHA and the stable patch ID and posts the `agentic/verdict` status check. The policy gate refuses it to any session that pushed the branch, so the coordinator cannot record its own work. Verifiers never push, merge, or comment.

## 2. Find the verified run

Walk up from the lowest unmerged PR. For each, run `agentic verify status <pr>`; it passes only when the latest verdict covers the current head SHA. Stop at the first PR that does not pass. A verified PR above an unverified one is not landable. Report the ceiling as a PR number and what breaks the chain.

## 3. Recheck that each verdict still describes the patch

Before landing a PR, recompute its patch ID (`gh pr diff <pr> | git patch-id --stable`) and compare it with the one `agentic verify status` and the status description report.

- **Patch changed:** the verdict is void. Re-verify (step 1).
- **Patch unchanged but head SHA changed** (for example after a rebase): the ledger has no row for the new SHA, so the policy layer denies the merge. Send it back to an independent verifier. The verifier may carry its verdict to the new SHA only after recomputing the patch ID itself, with evidence naming both SHAs and both patch IDs.
- **Unchanged:** still rerun mergeability and CI at the current head.

Never accept matching commit messages or an older SHA's green checks as a substitute.

## 4. Prepare only the bottom PR

Fetch trunk. If the bottom PR needs a rebase, rebase it onto the exact trunk tip; you are the root, the only writer of branch structure. Push the rebased branch only with `git push --force-with-lease`, only on an `agent/*` branch this run owns, and only if the policy layer permits it; otherwise pause and report. A rebase creates a new head SHA, so return to step 3. Retarget only the bottom PR to trunk. Do not touch descendants yet.

## 5. Land one PR

When the bottom PR is mergeable and its verdict is current, merge it with the repository's merge method (for example `gh pr merge <pr> --squash`). Arm auto-merge only if the user asked for merge-when-ready. The forge's required verdict check is the final gate; never bypass it.

## 6. Recompute after every merge

Fetch trunk and confirm the merged commit is present. Drop the merged PR from the frozen bottom-to-top list. Inspect the new bottom PR's base, head, checks, and patch ID; a host may retarget children automatically, but confirm it. Repeat from step 3. Independent work outside the chain ships on its own pass.

## 7. Stop at the ceiling

When the verified run has landed, report what landed, the next unverified PR, and what verifying it would take. Extending the run is a new pass from step 1. If the queue stalls, diagnose before changing anything.
