# ADR 0001: The agentic stack in agent-kit

- **Status:** accepted, 2026-10-07.
- **Scope:** the instructions, skills, and tools that let agents work with more autonomy across the user's repositories, in Pi and Claude Code.

## Context

The design (Lauren Tan's trust and correction-ladder approach, pstack's practice, and the user's decisions) asks agents to run with more autonomy without supervision. A first implementation added a local policy gate on every tool call: a shell classifier, Cedar policies, and the Jev classifier. Measured against pstack, that gate and most of the tooling around it caught no real mistake. Its cost was observed: false positives, three rounds of review spent chasing bypasses, and a silent hole in bypass-permission sessions. The full build and that analysis are kept on the `agent/reference-full-stack` branch ([`docs/analysis/2026-10-07-augmentation-vs-cruft.md`](../analysis/2026-10-07-augmentation-vs-cruft.md)).

## Constraints

- Agents use the user's GitHub token; there is no separate agent identity, so GitHub cannot tell the user from an agent.
- Pi is the primary harness and Claude Code the second. Codex is frozen.
- Enforcement must not hamper ordinary work.

## Decision

1. **Instructions carry the method.** A standing default replaces stored autonomy levels: reversible local work everywhere, and `agent/*` branches and pull requests in repositories the user owns. Merging and landing are modes the user invokes per run, as in pstack, with their criteria checked when they run. Planning happens only at one-way doors, the interaction contract, the correction ladder, and the reviewed learning path. They live in `claude/CLAUDE.md`, `pi/AGENTS.md`, and `skills/git-workflow`.
2. **The forge is the hard guarantee.** Every owned public repository carries the `agentic-backstop` ruleset, with no bypass actors (`agentic rulesets`, skill `github-rulesets`):
   - `baseline` everywhere: no deletion, no force-push, linear history;
   - `merge-gate` where a repository lands through pull requests: pull requests plus passing CI.
3. **Verification lives in the product repositories,** as skills built with `create-verification` and kept honest with `maintain-verification`.
4. **pstack is adapted, not forked.** Every adapted skill records its upstream commit, `agentic upstream-drift` reports drift, and `skills/RESYNC.md` records each review.
5. **Local enforcement stays small.** The existing `git-interceptor.ts` keeps guarding child publication and integration, `--no-verify`, and editor hangs in Pi. A larger gate returns only through the evidence rule: a mistake an agent actually made, routed through `correct`, enforced at the smallest effective scale first.

## Alternatives

- **The full local gate** (on the reference branch). Rejected for now: it had observed costs and no observed catches, and rulesets cover the most damaging mistakes on public repositories.
- **Forking pstack.** Rejected: it is Cursor-specific and changes fast.
- **Instructions only, with no forge backstop.** Rejected: rulesets are cheap and cannot be bypassed from a local session.

## Consequences

- **Some actions rest on instructions and the harness's own permission prompts,** not a local gate: messages to people, deploys, releases, credential changes, merges before `merge-gate`, and anything in private repositories.
- **Unattended sessions** (Claude in bypass-permission mode, Pi without a UI) have only rulesets and `git-interceptor` as hard stops.
- **Parked pieces stay on the reference branch:** the gate, `verify` and the verdict ledger, `orch`, `watch-pr`, `decision-log`, the lint tools, the Pi enforcement of the interaction contract, the learning code, and the evals harness.

## Reversal conditions

- **Reintroduce a gate** when a real session shows an agent reaching a hard point the instructions, prompts, and rulesets did not stop. Start at interceptor scale, with logging.
- **Bring back the verdict path** (`verify`, `orch`, `watch-pr`) with the `autopilot-stack` and `ship` modes; this is planned as the next change.
- **Revisit an agent identity** if agents run unattended on repositories others depend on.
