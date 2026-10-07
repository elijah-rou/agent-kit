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
| `agentic/` | Pi, Claude | The policy layer: shell classifier, Cedar policies, Jev filter, the `agentic` CLI and its Claude hook |

The repository root is a [Pi package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): Pi loads the
extensions, skills, prompt, and theme from it in place. Codex and Claude read linked files.

## Policy layer

Every Pi tool call passes through `pi/extensions/agentic-policy-gate.ts`; Claude Code runs
`agentic claude-hook` as a `PreToolUse` hook. Both evaluate the same Cedar policies in
`agentic/policy/` against your autonomy grants, which live outside every repository:

```toml
# ~/.config/agentic/grants.toml
[[grant]]
repo = "github.com/you/app"
level = 2   # A0 to A4; repos without a grant are A0

# ~/.config/agentic/config.toml
[jev]
enabled = true
threshold = 0.05   # unreadable commands proceed only when Jev's P(yes) is at or below this
```

The Jev key is read from `TYPESAFE_API_KEY` or the macOS keychain item `typesafe-jev`. Run
`bun install` once for the Cedar dependency; `agentic status` shows the effective level in a repository.

## Develop

```sh
scripts/validate   # needs Bun, ripgrep, zsh, and Python
```

It checks for private literals, validates every skill, and runs the policy layer, Pi extension, and Claude Mod tests
with Bun, the runtime bootstrap runs Pi on. Change a skill or extension here, then advance the pin in bootstrap's
`catalog.tsv`.

Repository-authored files are MIT licensed. Adapted skills keep their upstream licenses; see
[skills/README.md](skills/README.md).
