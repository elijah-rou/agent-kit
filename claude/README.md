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

Everything here runs on Bun. Bootstrap writes the machine-specific `settings.json` (status line command,
Mods enabled); model, effort, and permissions stay user choices.

## Git guard

`agentic/tools/git-guard/cli.ts --claude-hook` is a PreToolUse hook that applies the git policy Pi's
`git-interceptor` applies, to every tool that runs a shell command: Bash, Monitor, and PowerShell (Claude
Code 2.1.296's tools that execute code and take a command). It refuses skipping git hooks (`--no-verify`,
`git commit -n`, a `core.hooksPath` override) in every session, and refuses `git push`, `pull`, `merge`,
`rebase`, `cherry-pick`, `revert`, `am`, `apply`, `tag`, and `gh pr merge` inside a subagent (an event
carrying `agent_id`) unless its `agent_type` is `autopilot-owner`. The main session may publish. It denies
with Claude Code's JSON decision, which holds in bypass-permission mode too, and allows by printing nothing.
An event it cannot read is denied.

Bootstrap does not wire it yet: that is a pending bootstrap change, and until it lands no Claude Code
session runs the guard. The change adds this PreToolUse entry to `settings.json`, where `<kit>` is the
agent-kit checkout:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Monitor|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "bun --cwd <kit> <kit>/agentic/tools/git-guard/cli.ts --claude-hook",
            "timeout": 5,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

- `--cwd <kit>`: Claude Code starts the hook in the session's project, and Bun would load that project's
  `bunfig.toml`, whose preload could print before the decision or exit and turn a deny into an allow.
- `"timeout": 5`: the hook answers in well under a second.
- `"onFailure": "block"`: by default Claude Code lets the tool call continue when a hook cannot start
  (for example, `bun` is missing), times out, or exits other than 0 or 2. This setting, honored from Claude
  Code 2.1.295, turns those failures into a refusal; before 2.1.295 the guard fails open on them.

What the guard does not stop (the same list is in ADR 0001 and the verify-agent-kit `git-guard` feature):

- Commands it cannot see in the text: a program named through a variable, a shell alias or function, a
  script file, a subcommand supplied on stdin (`xargs git`), a git alias (`git p` for push), PowerShell's
  `Start-Process`, and other programs that publish (`gh pr create` or `comment`, `gh api`, a script).
- Hooks disabled another way: editing `.git/hooks` or `.git/config` (or a file it includes), or a
  `GIT_CONFIG_*` variable exported by an earlier command.
- Identity it cannot tell: a nested `claude -p` started from a subagent's shell has no `agent_id`, so it is
  treated as a main session; a child that holds the Agent tool (the built-in `general-purpose`) can launch an
  `autopilot-owner` grandchild, which may publish; and `agent_id` for teammates is documented but not observed.
- Other tools: MCP tools that run commands.

## Check changes

```sh
bun scripts/check-skills.ts
bun test claude/tests
```

`claude/tests/runtime.test.ts` runs only when a `claude` CLI is on PATH. It loads the Mod into a disposable
profile and runs native `/changes` and `/validate` with zero model usage. For typechecking, load the Mod once
with `claude --plugin-dir claude/mods/trial-tools` to generate `.claude-plugin/types/` for the installed
version, then run `tsc -p claude/mods/trial-tools --noEmit`.
