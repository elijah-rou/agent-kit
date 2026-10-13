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

1. **Instructions carry the method.** A standing default replaces stored autonomy levels: reversible local work everywhere, and `agent/*` branches and pull requests in repositories the user owns. Merging and landing happen only in the `autopilot-stack`, `ship`, and `autopilot-full` modes the user invokes per run, as in pstack; `babysit-and-ship` checks their preconditions (owned repository, a verification skill, and for `ship` and `autopilot-full` the `merge-gate` ruleset, or for `autopilot-full` in a private repository a local `agentic verify status` check) when they are invoked. In `autopilot-full`, each PR's owner, a child with the `autopilot-owner` role, pushes and merges its own PR after the coordinator's clean verdict, as in pstack; it is the one child the Pi `git-interceptor` lets publish. Planning happens only at one-way doors, the interaction contract, the correction ladder, and the reviewed learning path. They live in `claude/CLAUDE.md`, `pi/AGENTS.md`, and `skills/git-workflow`.
2. **The forge is the hard guarantee.** Every owned public repository carries the `agentic-backstop` ruleset, with no bypass actors (`agentic rulesets`, skill `github-rulesets`):
   - `baseline` everywhere: no deletion, no force-push, linear history;
   - `merge-gate` where a repository ships verified stacks: pull requests, passing CI, and the `agentic/verdict` status.
3. **Verification lives in the product repositories,** as skills built with `create-verification` and kept honest with `maintain-verification`. A fresh verifier records each pull request's verdict with `agentic verify`, bound to its head SHA and patch ID, in pstack's vendored `orch` ledger; `agentic watch-pr` (also vendored) follows pull requests and stacks.
4. **pstack is adapted, not forked.** Every adapted skill records its upstream commit, `agentic upstream-drift` reports drift, and `skills/RESYNC.md` records each review.
5. **Jev is advisory and only adds caution.** In public repositories, `ship` holds any PR that Jev rates above 0.3 for a one-way door, and a task Jev rates a one-way door, or classifies with confidence below 0.8, was to get a hint to use `design-checkpoint`; since 2026-10-12 that hint is recorded in shadow and not delivered ([ADR 0002](0002-task-routing.md)). The thresholds come from an eval on real commits and tasks from the user's public repositories. A clear score never lands a PR without its verdict, and a failed call holds the PR or gives no hint. Private repositories, and text containing a common credential format, are never sent to Jev; home directories are redacted. The hint path gives up after 3 s, so a prompt never waits longer. [ADR 0002](0002-task-routing.md) amends this decision for task prompts: they are sent from every repository not opted out, and every prompt is recorded.
6. **Local enforcement stays small.** One git policy, `agentic/tools/git-guard/classify.ts`, refuses skipping git hooks (`--no-verify`, `git commit -n`, a `core.hooksPath` override) for every session, and git publication and integration (and `gh pr merge`) for every child but an `autopilot-owner`. Pi's `git-interceptor.ts` applies it, and also blocks editor hangs. In Claude Code, the PreToolUse hook `git-guard --claude-hook` applies it to the Bash, Monitor, and PowerShell tools, telling a subagent by the event's `agent_id`; bootstrap does not wire it yet (a pending bootstrap change), so until then Claude Code runs without it. A larger gate returns only through the evidence rule: a mistake an agent actually made, routed through `correct`, enforced at the smallest effective scale first.

## Alternatives

- **The full local gate** (on the reference branch). Rejected for now: it had observed costs and no observed catches, and rulesets cover the most damaging mistakes on public repositories.
- **Forking pstack.** Rejected: it is Cursor-specific and changes fast.
- **Instructions only, with no forge backstop.** Rejected: rulesets are cheap and cannot be bypassed from a local session.

## Consequences

- **Some actions rest on instructions and the harness's own permission prompts,** not a local gate: messages to people, deploys, releases, credential changes, merges before `merge-gate`, and anything in private repositories.
- **Task prompts and PR diffs from public repositories go to TypeSafe.** The prompts include whatever the user types there.
- **Jev's PR screen misses some one-way doors:** 9 of 82 in the eval, licenses among them. It narrows what `ship` lands unattended and is not a guarantee. The task hint misses some too (2 of 30), and appears on about 1 in 8 other tasks.
- **Unattended sessions** (Claude in bypass-permission mode, Pi without a UI) have only rulesets and the git guard as hard stops, and in Claude only once bootstrap wires the guard and on Claude Code 2.1.295 or later, where a guard that fails or times out refuses the call instead of letting it run. A PreToolUse deny holds in bypass-permission mode. The guard does not stop (the same list is in `claude/README.md` and the verify-agent-kit `git-guard` feature): commands it cannot see in the text (a program named through a variable, a shell alias or function, a script file, a subcommand supplied on stdin, a git alias, PowerShell's `Start-Process`, and other programs that publish, such as `gh pr create`, `gh api`, or a script); hooks disabled another way (editing `.git/hooks` or `.git/config`, or a `GIT_CONFIG_*` variable exported by an earlier command); identity it cannot tell in Claude (a nested `claude -p` started from a subagent's shell has no `agent_id` and counts as a main session, a child holding the Agent tool can launch an `autopilot-owner` grandchild, and `agent_id` for teammates is documented but not observed); and MCP tools that run commands.
- **In private repositories, `autopilot-full` merges rest on the agents' own `agentic verify status` check.** Rulesets are unavailable there on the user's plan, so nothing outside the agents enforces the verdict.
- **Verifier independence is a convention.** Nothing local stops an author from recording a verdict on its own work, and the forge cannot tell who posted the status, because everyone uses the user's token. The ledger records the verifier's ID, so a self-recorded verdict is visible after the fact.
- **Every pull request in a `merge-gate` repository needs a verdict,** the user's own included.
- **Parked pieces stay on the reference branch:** the gate, `decision-log` (the decision log is a plain TSV appended with pstack's `log.sh`), the lint tools, the Pi enforcement of the interaction contract, the learning code, and the evals harness.

## Reversal conditions

- **Reintroduce a gate** when a real session shows an agent reaching a hard point the instructions, prompts, and rulesets did not stop. Start at interceptor scale, with logging.
- **Enforce verifier independence** if a session shows an author recording its own verdict.
- **Revisit an agent identity** if agents run unattended on repositories others depend on.
