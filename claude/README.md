# Claude Code

What bootstrap's `--tools claude` selection installs into the Claude configuration directory
(`CLAUDE_CONFIG_DIR`, or `~/.claude`):

- `CLAUDE.md`: the global working rules.
- `skills.txt`: the skills exported to Claude, from `skills/` or the Claude-specific adaptations in
  `claude/skills/`. Exports stay runtime-neutral; `scripts/check-skills.ts` enforces it.
- `mods/trial-tools`: a Claude Code Mod with clipboard, Git, throughput, and validation commands. See
  its [README](mods/trial-tools/README.md).
- `statusline.ts`: a quota footer that renders the rate limits Claude supplies on stdin. It never reads
  credentials or calls provider APIs; missing, invalid, or stale data shows `limits: n/a`.
- The git guard, `agentic/tools/git-guard/cli.ts --claude-hook`: a PreToolUse hook on the Bash tool that
  applies the git policy Pi's `git-interceptor` applies. See [Git guard](#git-guard).

Everything here runs on Bun. Bootstrap writes the machine-specific `settings.json` (status line command,
Mods enabled, hooks); model, effort, and permissions stay user choices.

## Git guard

The hook refuses any git command with `--no-verify`, in every session, and `git push`, `pull`, `merge`,
`rebase`, `cherry-pick`, `revert`, `am`, `apply`, and `tag` inside a subagent (an event carrying `agent_id`)
unless its `agent_type` is `autopilot-owner`. The main session may publish. It denies with Claude Code's
JSON decision, which holds in bypass-permission mode too, and allows by printing nothing. An event it cannot
read is denied.

Bootstrap wires it into `settings.json` as a PreToolUse entry with a Bash matcher, where `<kit>` is the
agent-kit checkout:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bun <kit>/agentic/tools/git-guard/cli.ts --claude-hook",
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

By default Claude Code lets the tool call continue when a hook cannot start, times out, or exits other than 0 or 2;
`"onFailure": "block"` (Claude Code 2.1.295 or later) turns those failures into a refusal.

## Check changes

```sh
bun scripts/check-skills.ts
bun test claude/tests
```

`claude/tests/runtime.test.ts` runs only when a `claude` CLI is on PATH. It loads the Mod into a disposable
profile and runs native `/changes` and `/validate` with zero model usage. For typechecking, load the Mod once
with `claude --plugin-dir claude/mods/trial-tools` to generate `.claude-plugin/types/` for the installed
version, then run `tsc -p claude/mods/trial-tools --noEmit`.
