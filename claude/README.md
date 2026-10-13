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
Code 2.1.296's tools that execute code and take a command). The policy is two text patterns kept from Pi's
original interceptor; the guard does not read the command as a shell would. In every session it refuses
`--no-verify` after `git` on the same line (but not `--no-verify-signatures`). Inside a subagent (an event
carrying `agent_id`), unless its `agent_type` is `autopilot-owner`, it refuses a line, or a command after
`;`, `&`, or `|`, that starts `git push`, `pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `apply`,
or `tag` (except listing or verifying tags), optionally after `git -C <path>` options; `git merge-base` and
other hyphenated subcommands do not match. The main session may publish. It denies with Claude Code's JSON
decision, which holds in bypass-permission mode too, and allows by printing nothing. An event it cannot read
is denied.

What it refuses that it need not (the same list is in ADR 0001 and the verify-agent-kit `git-guard` feature):

- Mentions. The patterns see a git command at the start of any line or after `;`, `&`, or `|`, even inside
  a quoted commit message, a here document, or a search pattern (`rg "error|git push"`). The reason says
  the text may be a mention: commit such a message from a file (write it with the editor tool, then
  `git commit -F <file>`), and search for `--no-verify` without its leading dashes, or for a command
  without `git` in front.
- A child's harmless uses of a refused subcommand, such as `git rebase --abort`.

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

- A git command the patterns do not see in the text: one not at the start of a line or after `;`, `&`, or
  `|` (leading spaces, an absolute path such as `/usr/bin/git`, an assignment, redirection, or keyword
  before it, a wrapper such as `command`, `env`, `sh -c`, `eval`, or `xargs`, a subshell or substitution,
  PowerShell's call operator or backtick escapes), git options before the subcommand other than `-C`
  (`git -c x=y push`, `git --git-dir=x push`), `--no-verify` on a later line than its `git` (after a here
  document in a commit message), shell aliases and functions, git and gh aliases, and script files.
- Hooks skipped another way: `git commit -n`, `git am -n`, a prefix of `--no-verify` such as `--no-veri`,
  an override or `git config` change of `core.hooksPath` or a `hook.*` key (`git -c`, `GIT_CONFIG_*`
  variables), a hook manager's skip variable (`HUSKY=0`, `SKIP=...`, and the like), and editing
  `.git/hooks` or `.git/config`.
- Other programs that publish: `git send-pack`, `git http-push`, `git subtree push`, `pull`, or `merge`,
  `gh pr merge`, `gh pr create` or `comment`, and `gh api`.
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
