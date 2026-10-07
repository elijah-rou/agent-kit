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

The instructions carry a standing default for what agents may do on their own (local work, and `agent/*` branches and pull requests in repositories you own), planning only at one-way doors, and a contract for questions and reports. Merging and landing happen only in the autopilot-stack and ship modes you invoke per run (`babysit-and-ship`): a fresh verifier records a verdict per pull request (`agentic verify`, kept in pstack's `orch` ledger), `agentic watch-pr` follows the stack, and the forge requires the verdict before a merge. In public repositories, TypeSafe's Jev adds two advisory checks (`agentic jev`): `ship` holds a PR it rates a likely one-way door for you, and a task it rates a possible one-way door gets a hint to use `design-checkpoint` (a Claude hook and a Pi extension). They need a TypeSafe key in `TYPESAFE_API_KEY` or, on macOS, the keychain item `typesafe-jev`; text with anything shaped like a credential is never sent. GitHub rulesets are the hard backstop (`agentic rulesets`), and verification skills live in the product repositories. [ADR 0001](docs/adr/0001-agentic-stack.md) records the decision. That includes why the larger local policy gate is parked on the `agent/reference-full-stack` branch.

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
