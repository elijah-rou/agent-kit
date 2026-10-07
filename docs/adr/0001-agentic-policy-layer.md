# ADR 0001: A shared policy layer for agent autonomy

- **Status:** accepted, 2026-10-07.
- **Scope:** the `agentic/` policy layer, its Pi and Claude Code adapters, and the GitHub ruleset backstop.

## Context

Agents work with more autonomy when the environment, not supervision, keeps their mistakes recoverable. The design adopted Lauren Tan's approach (trust from verification, structure, and correction routing) and pstack's practice, which is mostly convention plus audit. Some mistakes cannot wait for an audit: publishing or merging to shared branches, messages to people, deploys, deleting data, credential changes, and an agent loosening its own limits. Pi and Claude Code shared no code for this, and some checks already existed twice.

## Constraints

- Agents use the user's GitHub token. A separate agent identity was declined, so GitHub cannot tell the user from an agent.
- Pi is the primary harness, Claude Code the second. Codex is frozen.
- The gate must not hamper ordinary work, and it must fail closed when it breaks: Claude Code runs a tool when its hook errors or times out.

## Decision

1. **Build in agent-kit, with pstack as a pinned reference.** Skills are adapted with provenance and checked for upstream drift. pstack is not forked.
2. **Enforce only where an after-the-fact catch is too late.** The hard points are publication and merge, the autonomy ceiling from user-level grants, messages to people, and writes to the gate's own control files. Everything else follows convention, audit, and cheap linters.
3. **A pluggable decision pipeline:**
   - a deterministic shell classifier reads each tool call into hard-point actions;
   - a fact loader adds grants, repository settings, ledger verdicts, and forge state;
   - Cedar policies decide, with forbids carrying `@effect("deny" | "ask")`. Repositories may only add forbids;
   - for commands the classifier cannot read, the Jev classifier is consulted. Attended sessions proceed only on P(yes) ≤ 0.05; unattended sessions and children deny opaque execution and P(yes) ≥ 0.8 and run the rest.
4. **Threat model.** The gate stops a cooperative agent pursuing its task from reaching a hard point without the user, or from loosening its own limits when blocked. It does not try to stop a determined agent: same-user code can always assemble a command at run time. The classifier grows only from observed agent behavior, routed through `correct` with a past mistake in `agentic/rules.toml`.
5. **Forge backstop.** Every owned public repository carries the `agentic-backstop` ruleset with no bypass actors: no deletion, force-push, or merge commits on the default branch, and from autonomy A3 a pull request plus the `agentic/verdict` check. Only `agentic verify record`, run by a session that did not push the branch, writes verdicts.

## Alternatives

- **Fork pstack.** Rejected: it is written for Cursor and changed in 117 files in one month, so a fork would drift within weeks.
- **A separate local service exposed over MCP.** Rejected: both harnesses already have hook points, and a CLI plus libraries is pluggable without another process to keep alive.
- **Hand-written decision logic, or OPA/Rego.** Cedar won the trial. It embeds through WASM under Bun and inside Pi, validates policies against a schema, makes forbid-overrides-permit native, and evaluated in about 0.12 ms.
- **Instructions only.** Rejected for the hard points: an instruction is skipped often enough that an irreversible action would eventually happen.
- **Patching every bypass a reviewer can construct.** Rejected under the threat model: it hampered normal work without stopping a determined agent.

## Consequences

- One policy layer serves Pi (an extension), Claude Code (a fail-closed `PreToolUse` hook), and the `agentic` CLI.
- The gate protects its own wiring. Editing the live checkout asks, which is a deny in sessions that cannot prompt, so the gate is developed in another worktree and reaches the live setup through the bootstrap pin.
- Without an agent identity, the forge enforces mechanics, not human approval. Private repositories on the free plan rely on the local gate.
- Jev sends redacted command text to an outside service for unreadable commands only.

## Reversal conditions

- **Agent identity:** introduce one if agents run unattended on repositories others depend on, or if the decision log shows a hard point bypassed.
- **Cedar:** replace it if schema validation or embedding becomes a maintenance cost larger than the policies it expresses. The pipeline isolates it behind `src/engine.ts`.
- **Jev in the gate:** revisit if its false-allow rate on observed traffic exceeds the eval's bound, or if its data handling becomes unacceptable.
- **Reverting the whole layer:** relink with the previous agent-kit pin. Claude settings are re-rendered without the hook, and nothing reads `~/.config/agentic` once the gate is gone.
