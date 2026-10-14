# agent-kit

Instructions, skills, Pi extensions, and Claude Code mods shared by Pi, Codex, and Claude Code.
[bootstrap](https://github.com/elijah-rou/bootstrap) pins a commit of this repository and links it
for whichever agents a machine selects; agent configuration (models, providers, settings) stays there.

| Path | Used by | Contents |
| --- | --- | --- |
| `skills/` | Pi, Codex, Claude | Shared skills; licenses for adapted skills sit alongside them |
| `pi/` | Pi | `AGENTS.md`, worktree guidance, extensions and their tests, prompt, theme |
| `codex/` | Codex | `AGENTS.md`, native tool notes, and the skills Codex exports |
| `claude/` | Claude Code | `CLAUDE.md`, exported skills and adaptations, the trial-tools Mod, status line |
| `agentic/` | You and agents | The `agentic` CLI: `rulesets` (the GitHub backstop) and `upstream-drift` (changes in adapted upstream skills) |

The repository root is a [Pi package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): Pi loads the
extensions, skills, prompt, and theme from it in place. Codex and Claude read linked files.

## Agentic stack

The instructions carry a standing default for what agents may do on their own (local work, and `agent/*` branches and pull requests in repositories you own), planning only at one-way doors, and a contract for questions and reports. Merging and landing happen only in the autopilot-stack, ship, and autopilot-full modes your own words invoke per run ("autopilot", "land these", "ship it"; "stack them, I'll land" keeps landing with you; `babysit-and-ship`): a fresh verifier records a verdict per pull request (`agentic verify`, kept in pstack's `orch` ledger), `agentic watch-pr` follows the stack, and the agent merges only after `agentic verify status` passes for the exact head it merges. A pull request that changes the verification policy itself lands only when you approve it in words, which the coordinator records as a `countersigned` verdict. TypeSafe's Jev adds two advisory checks (`agentic jev`). In public repositories, a PR it rates a likely one-way door gets a second review before it lands. Every task prompt in Claude Code, Codex, and Pi is routed ([ADR 0002](docs/adr/0002-task-routing.md)), and since 2026-10-14 the door, lookup, and loop notes are delivered as advice on trial, never as a block, and measured with `agentic jev route-report`; turns the runtime starts itself, such as task notifications, are recorded but never sent. Each prompt adds one record without its text to `$XDG_STATE_HOME/agentic/task-route/`. A repository that commits `.agents/jev-opt-out` never sends its prompts, and `AGENTIC_ROUTE=off` stops routing for a session. The hooks need a TypeSafe key in `TYPESAFE_API_KEY` or, on macOS, the keychain item `typesafe-jev`; Pi uses the TypeSafe credential in its own registry. Text containing a common credential format is never sent. GitHub rulesets are the hard backstop against deleting or force-pushing the default branch (`agentic rulesets`), and verification skills live in the product repositories. [ADR 0001](docs/adr/0001-agentic-stack.md) records the decision. That includes why the larger local policy gate is parked on the `agent/reference-full-stack` branch.

## Develop

```sh
bun install --frozen-lockfile
scripts/validate   # needs Bun, ripgrep, zsh, and Python
```

It checks for private literals, validates every skill, and runs the agentic tool, Pi extension, and Claude Mod tests
with Bun, the runtime bootstrap runs Pi on. Change a skill or extension here, then advance the pin in bootstrap's
`catalog.tsv`.

Repository-authored files are MIT licensed. Adapted skills keep their upstream licenses; see
[skills/README.md](skills/README.md).
