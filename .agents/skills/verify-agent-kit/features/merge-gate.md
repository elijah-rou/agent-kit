# Merge gate

A fresh verifier records its verdict for an open pull request in the repository's orch ledger, bound to the head SHA and the stable patch ID, and anyone can check whether the latest verdict still covers the head. The `merge-gate` GitHub ruleset makes the forge refuse a merge without a passing `agentic/verdict` status; `agentic rulesets plan` shows what applying it would change.

## Sub-features

- `verify-usage` rejects a missing command with exit 2.
- `verify-status` reads a pull request's ledger state and forge status.
- `verify-refuse-closed` refuses to record a verdict for a merged pull request.
- `verify-record` records a verdict for an open pull request, bound to its head and patch, with the verifier's ID.
- `verify-readback` reads that verdict back as passing, and says to publish when the forge disagrees.
- `rulesets-plan` plans the `baseline` and `merge-gate` rulesets for a repository without changing it.

## How to get to it (user POV)

- A verifier runs `agentic verify record <pr> --verdict <verdict> --evidence <path or URL>` with `AGENTIC_AGENT_ID` set.
- Anyone runs `agentic verify status <pr>` before landing.
- The coordinator runs `agentic verify publish <pr>` to post the status (not driven here: it changes GitHub).
- The user runs `agentic rulesets plan <owner/repo> --tier merge-gate`, then `apply` to change the repository (not driven here: it changes GitHub).

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID merge-gate [--pr N] [--merged-pr N] [--repo owner/name]`.
- `gh` is logged in. The repository has a merged pull request and, for `verify-record` and `verify-readback`, an open one (`--pr`, or the newest open one). Without an open pull request the drive checks every other step and ends with `SKIP`.

- **Usage.** `agentic verify` and `agentic rulesets` with no command exit 2.
- **Plan.** `agentic rulesets plan <repo> --tier baseline` and `--tier merge-gate` exit 0 and name the repository and tier.
- **Status of a merged pull request.** `agentic verify status <merged>` prints `<repo>#<merged> (MERGED, ...): ledger none ...` and exits 1.
- **Refusal.** `agentic verify record <merged> ...` exits 1 with `verdicts are for open pull requests`, and no `ledger.tsv` appears.
- **Record.** With `AGENTIC_ORCH_STORE` set to the run's `orch/` and `AGENTIC_AGENT_ID=verify-agent-kit-<RUN_ID>`, `agentic verify record <open> --verdict unit-test-verified --evidence <file>` prints `recorded unit-test-verified on <head>`.
- **Read back.** `orch/ledger.tsv`'s last row holds the pull request, its head SHA, `patch:<id>`, and the verifier ID. `agentic verify status <open>` prints `ledger pass (unit-test-verified ...)`, and either exits 0 or names `agentic verify publish <open>`.
- **Proof.** Evidence: `merge-gate/NN-*.txt` for each command and `merge-gate/ledger.tsv`, the run's ledger as written.

## Gotchas

- `verify` finds the ledger through git's common directory unless `AGENTIC_ORCH_STORE` is set. Without it, a drive would write into the real repository's ledger; the drive always sets it.
- `verify` asks GitHub for the pull request before it checks its own arguments, so an argument error after the pull request number needs network to reach.
- A recorded verdict in this run's store says nothing to the forge; `agentic verify status` against the real ledger is unaffected.
- `rulesets plan` exits 0 whether or not changes are pending; read its `changes` line.
