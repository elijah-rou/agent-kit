# Coordinating several agents

Read before spawning workers for an unattended program. If one agent can finish the work within the run, do not coordinate: run the loop yourself.

## Roles

- **One coordinator** per program. It frames the run, writes briefs, accepts results, and is the only agent that publishes.
- **One owner per pull request.** It builds and babysits that PR. A takeover is explicit and recorded in the PR body.
- **The root is the only writer of branch structure:** rebases, retargets, and stack order.
- **Verifiers** are agents that did not write the code, preferably on a different model family. A worker may self-report; a verifier's verdict overrides it.

## Children

- Brief each child with its objective, workspace, authority boundary, decisions already made, acceptance check, expected output, and when to stop and escalate.
- Each child works in its own worktree and branch; one writer per checkout.
- Tell each child it does not push, merge, deploy, or post, and do not hand children credentials that could.
- Child reports are evidence, not acceptance. Check their artifacts before relying on them.

## Shared state

- Per-run and per-agent files have a single writer. Readers combine them at read time.
- Program state lives in the vendored `orch` store, which locks itself and writes atomically: `agentic orch --store <dir> <command>` (see its `--help`). The verdict ledger's store is `$(git rev-parse --git-common-dir)/agentic/orch`, shared by every worktree. Verdicts go in its ledger, keyed by PR and head SHA, recorded only by a fresh verifier through `agentic verify record` and published by the coordinator with `agentic verify publish`; a new head SHA voids the verdict.

## Audit tick

For unattended programs, run an audit tick about hourly:

1. Re-read the governing skill from the default branch, not from memory.
2. Audit the program against it.
3. Count only side effects as progress: commits, pushes, PR or check changes, ledger and store rows. A busy transcript is not progress.
4. Replace a lane with no side effects since the last tick. Probe it read-only first (store, ledger, branches); do not resume an agent just to check on it.
5. Log one decision row per tick.
