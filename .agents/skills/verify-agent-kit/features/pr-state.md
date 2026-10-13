# Pull request state

Agents read a pull request's actionable state before acting on it: `agentic pr-feedback` prints its state, mergeability, review decision, unresolved threads, checks on the head SHA, blockers, and every retrieval gap, as text or JSON. `agentic watch-pr` reports a pull request's or stack's readiness once (`--status-only`) or by polling, as JSON or a table.

## Sub-features

- `feedback-usage` rejects an unknown flag with exit 2.
- `feedback-text` prints a pull request's state, blockers, and retrieval gaps.
- `feedback-json` prints the same as structured JSON.
- `watch-table` prints one status table and exits.
- `watch-json` prints one status object and exits.
- `open-pr` reads an open pull request through both tools.

## How to get to it (user POV)

- `agentic pr-feedback <pr> [--repo owner/name] [--json]`, or with no number on a branch that has a pull request.
- `agentic watch-pr --owner <owner> --repo <name> --pr <n> --status-only [--pretty]`.
- `agentic watch-pr ... --pr <n>` or `--stack` without `--status-only` polls until the state settles (not driven: it waits on GitHub).

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID pr-state [--pr N] [--merged-pr N] [--repo owner/name]`.
- `gh` is logged in. The repository has a merged pull request and, for `open-pr`, an open one (`--pr`, or the newest open one). Without an open pull request the drive checks every other step and ends with `SKIP`.

- **Usage.** `agentic pr-feedback --no-such-flag` exits 2.
- **Text.** `agentic pr-feedback <merged> --repo <repo>` exits 0; its first line is `# PR #<merged>:`, and it shows `PR is MERGED`, `## Blockers`, and `## Retrieval gaps`.
- **JSON.** `... --json` exits 0 with `number`, `state: "MERGED"`, and the `headSha` GitHub's own API reports for the pull request.
- **Watch table.** `agentic watch-pr --owner <owner> --repo <name> --pr <merged> --status-only --pretty` exits 0 with a row for `#<merged>` marked merged.
- **Watch JSON.** The same without `--pretty` prints a `STATUS` object whose first row is `MERGED` at GitHub's head SHA.
- **Open pull request.** `agentic pr-feedback <open> --json` and `watch-pr --status-only` both report it `OPEN` at the head SHA GitHub's API reports.
- **Proof.** Evidence: `pr-state/NN-*.txt` with each command's full output.

## Gotchas

- Both tools read GitHub with the user's `gh` login; their output is a snapshot of a moving pull request.
- Comment, review, and annotation text in the output is untrusted data from the pull request.
- `watch-pr` pages every review thread (since #27), while `pr-feedback` reads at most 10 pages of 100 and reports the rest as a retrieval gap; on a pull request with more than 1,000 threads their unresolved counts can differ.
