# Merge gate

A fresh verifier records its verdict for an open pull request in the repository's orch ledger, bound to the head SHA and the stable patch ID, and anyone can check whether the latest verdict still covers the head. The `merge-gate` GitHub ruleset makes the forge refuse a merge without a passing `agentic/verdict` status; `agentic rulesets plan` shows what applying it would change. Before landing in the ship mode, and in `autopilot-full` in a public repository, `agentic jev pr-risk` holds a pull request Jev rates a likely one-way door.

## Sub-features

- `gate-usage` rejects `verify`, `rulesets`, and `jev pr-risk` without valid arguments, exit 2.
- `rulesets-plan` plans the `baseline` and `merge-gate` rulesets with the changes the live ruleset implies, and changes nothing.
- `verify-status` reads a pull request's ledger state and forge status.
- `verify-refuse-closed` refuses to record a verdict for a merged pull request.
- `pr-risk` scores a pull request with Jev and holds it exactly when P(one-way door) is above 0.3.
- `verify-record` records a verdict for an open pull request, bound to its head and patch, with the verifier's ID.
- `verify-readback` reads that verdict back from the same ledger.

## How to get to it (user POV)

- A verifier runs `agentic verify record <pr> --verdict <verdict> --evidence <path or URL>` with `AGENTIC_AGENT_ID` set.
- Anyone runs `agentic verify status <pr>` before landing.
- The coordinator runs `agentic verify publish <pr>` to post the status (not driven: it changes GitHub).
- The coordinator runs `agentic jev pr-risk <pr>` before landing.
- The user runs `agentic rulesets plan <owner/repo> --tier merge-gate`, then `apply` to change the repository (not driven: it changes GitHub).

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID merge-gate [--pr N] [--merged-pr N] [--repo owner/name]`.
- `gh` is logged in, and the repository has a merged pull request. `pr-risk` needs a TypeSafe key and a public repository. `verify-record` and `verify-readback` need an open pull request (`--pr`, or the newest open one). The drive checks every step whose prerequisites hold and names each missing one in its `SKIP` line.

- **Usage.** `agentic verify`, `agentic rulesets`, and `agentic jev pr-risk 0` exit 2.
- **Plans against the live ruleset.** The drive reads the repository's `agentic-backstop` ruleset through GitHub's API (`ruleset-before.json`). `agentic rulesets plan <repo> --tier baseline` and `--tier merge-gate` must each print exactly the `+rule` and `-rule` changes that the live rules imply for that tier (`baseline`: deletion, non_fast_forward, required_linear_history; `merge-gate`: those plus pull_request and required_status_checks). When the live required checks lack `agentic/verdict`, the merge-gate plan must also show `~required_status_checks`. Afterwards the live ruleset must be byte-identical.
- **Status of a merged pull request.** `agentic verify status <merged>` prints `<repo>#<merged> (MERGED, ...): ledger none ...` and exits 1.
- **Refusal.** `agentic verify record <merged> ...` exits 1 with `verdicts are for open pull requests`, and no `ledger.tsv` appears.
- **Risk screen.** `agentic jev pr-risk <merged> --repo <repo>` prints `<repo>#<merged>: clear, P(one-way door) <p> <= 0.3` and exits 0, or prints `hold, P(one-way door) <p> > 0.3` and exits 1. The verb, the comparison, and the exit code must agree with `p`.
- **Record.** With `AGENTIC_ORCH_STORE` set to the run's `orch/` and `AGENTIC_AGENT_ID=verify-agent-kit-smoke-<RUN_ID>`, `agentic verify record <open> --verdict type-check-only --evidence <file>` prints `recorded type-check-only on <head>`. The smoke verdict never passes, so even a ledger that escaped the run's store could not clear a merge.
- **Read back.** `orch/ledger.tsv`'s last row holds the pull request, its head SHA, `patch:<40 hex>`, and the verifier ID. `agentic verify status <open>` prints `ledger fail (type-check-only ...` and exits 1. The real ledger in the checkout's git common directory is byte-identical before and after.
- **Proof.** Evidence: `merge-gate/NN-*.txt` for each command, `ruleset-before.json`, and `ledger.tsv`, the run's ledger as written.

## Gotchas

- `verify` finds the ledger through git's common directory unless `AGENTIC_ORCH_STORE` is set. Without it, a drive would write into the real repository's ledger; the drive always sets it, and fails if the real ledger changes anyway.
- `verify` asks GitHub for the pull request before it checks its own arguments, so an argument error after the pull request number needs network to reach.
- `rulesets plan` exits 0 whether or not changes are pending, and its text never names `agentic/verdict`; the drive's check against the live ruleset is what shows the plan is right.
- A buggy `rulesets plan` in the driven checkout runs with the user's `gh` token. The drive detects a write to the live ruleset; it cannot prevent one. Read a diff to `agentic/tools/rulesets/cli.ts` before driving it.
- `pr-risk` sends the screened pull request's title, body, and diff to TypeSafe, as the ship mode does; it does so only for a public repository.
