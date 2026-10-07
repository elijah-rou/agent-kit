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

The instructions carry an autonomy ladder that you grant per repository, planning only at one-way doors, and a contract for questions and reports. GitHub rulesets are the hard backstop (`agentic rulesets`), and verification skills live in the product repositories. [ADR 0001](docs/adr/0001-agentic-stack.md) records the decision. That includes why the larger local policy gate is parked on the `agent/reference-full-stack` branch.

## Develop

```sh
scripts/validate   # needs Bun, ripgrep, zsh, and Python
```

It checks for private literals, validates every skill, and runs the agentic tool, Pi extension, and Claude Mod tests
with Bun, the runtime bootstrap runs Pi on. Change a skill or extension here, then advance the pin in bootstrap's
`catalog.tsv`.

Repository-authored files are MIT licensed. Adapted skills keep their upstream licenses; see
[skills/README.md](skills/README.md).
