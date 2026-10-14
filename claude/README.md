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
Code 2.1.296's tools that execute code and take a command). The policy is text patterns; the guard does not
read the command as a shell would. They find `git` or `gh`, by name or by absolute path (`/usr/bin/git`), at
the start of a line or after `;`, `&`, or `|`. In every session they refuse skipping hooks:

- `--no-verify` after `git` (but not `--no-verify-signatures`), on the same line or on a later line that a
  quoted string or a line-ending backslash carries the command onto, as in Claude Code's usual commit form
  `git commit -m "$(cat <<'EOF' ... EOF\n)" --no-verify`;
- `-n` on `git commit` or `git am`, alone or after short flags that take no value (`-an`, `-nm`, `-anm`),
  up to the next `;`, `&`, or `|`; a word git itself refuses as a misspelled long option (`-include`,
  `-only`, `-no-op`) does not count;
- a hook manager's skip variable (`HUSKY`, `HUSKY_SKIP_HOOKS`, `SKIP`, `PRE_COMMIT_ALLOW_NO_CONFIG`,
  `LEFTHOOK`, `LEFTHOOK_EXCLUDE`, `OVERCOMMIT_DISABLE`) assigned at the start of a command, alone or after
  `export` and its kin, on a line that runs git, or on a line of only assignments just before a line that
  starts git (`HUSKY=0 git commit`, `export SKIP=lint && git commit`, `export HUSKY=0` then `git commit` on
  the next line);
- `core.hooksPath` or a `hook.*` key set with `git -c` or `--config-env` before the subcommand, or set,
  unset, or removed with `git config` (reading one with `git config <key>` or `--get` passes, and
  redirections such as `2>/dev/null` and a trailing `# comment` are not read as a value).

Inside a subagent (an event carrying `agent_id`), unless its `agent_type` is `autopilot-owner`, they also
refuse a line, or a command after `;`, `&`, or `|`, that starts `git push`, `pull`, `merge`, `rebase`,
`cherry-pick`, `revert`, `am`, `apply`, or `tag` (except listing or verifying tags), optionally after
`git -C <path>` options, or `gh pr merge`; `git merge-base` and other hyphenated subcommands do not match.
The main session may publish. It denies with Claude Code's JSON decision, which holds in bypass-permission
mode too, and allows by printing nothing. An event it cannot read is denied.

What it refuses that it need not (the same list is in ADR 0001 and the verify-agent-kit `git-guard` feature):

- Mentions. The patterns see a git command at the start of any line or after `;`, `&`, or `|`, even inside
  a quoted commit message, a here document, or a search pattern (`rg "error|git push"`); `--no-verify`
  anywhere in a quoted message or here document that spans lines after `git` (including a
  `gh pr create --body` after `git push` on the same command, whose reason also names `--body-file`); and a word that git would read as `-n`
  anywhere in a `git commit` or `git am` command before its next `;`, `&`, or `|`
  (`git commit -m "fix -n handling"`). The
  reason says the text may be a mention: commit such a message from a file (write it with the editor tool,
  then `git commit -F <file>`), and search for `--no-verify` without its leading dashes, or for a command
  without `git` or `gh` in front.
- A skip variable assigned for another command on a line that also runs git (`SKIP=1 make && git status`).
- A child's harmless uses of a refused subcommand, such as `git rebase --abort`.

Bootstrap wires it on install. Its `claude/settings.json` carries this PreToolUse entry, and its installer
replaces `@AGENT_KIT@` with the agent-kit checkout and `@BOOTSTRAP_ROOT@` with the bootstrap root:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Monitor|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "test ! -f \"@AGENT_KIT@/agentic/tools/git-guard/cli.ts\" || \"@BOOTSTRAP_ROOT@/tools/bin/bun\" --cwd \"@AGENT_KIT@\" \"@AGENT_KIT@/agentic/tools/git-guard/cli.ts\" --claude-hook",
            "timeout": 5,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

- `test ! -f ... ||`: the hook allows the call, without running the guard, when the guard file is absent
  (no agent-kit checkout, as after uninstall, or a checkout without `agentic/tools/git-guard/cli.ts`).
- `@BOOTSTRAP_ROOT@/tools/bin/bun`: the hook runs bootstrap's own Bun, not one from Claude Code's `PATH`.
- `--cwd @AGENT_KIT@`: Claude Code starts the hook in the session's project, and Bun would load that
  project's `bunfig.toml`, whose preload could print before the decision or exit and turn a deny into an
  allow.
- `"timeout": 5`: the hook answers in well under a second.
- `"onFailure": "block"`: by default Claude Code lets the tool call continue when a hook cannot start
  (for example, bootstrap's Bun is missing), times out, or exits other than 0 or 2. This setting, honored
  from Claude Code 2.1.295, turns those failures into a refusal; before 2.1.295 the guard fails open on them.

What the guard does not stop (the same list is in ADR 0001 and the verify-agent-kit `git-guard` feature):

- A git or gh command the patterns do not see in the text: one not at the start of a line or after `;`,
  `&`, or `|` (leading spaces, a path that does not start with `/` such as `./git` or `~/bin/git`, a name
  with an extension such as `git.exe push`, an assignment other than a skip variable, a redirection, or a
  keyword before it, a wrapper such as `command`, `env`, `sh -c`, `eval`, or `xargs`, a subshell or
  substitution, PowerShell's call operator or backtick escapes), git options before the subcommand other
  than `-C` (`git --git-dir=x push`; `-c` and `--config-env` are read only for hook keys), `--no-verify` on
  a later line that the command reaches another way (an unquoted `$(...)` spanning lines, or a here
  document inside a quoted string that holds an unpaired double quote), shell aliases and functions, git
  and gh aliases, and script files.
- Hooks skipped another way: a prefix of `--no-verify` such as `--no-veri`; `-n` after a quoted `;`, `&`,
  or `|` in its `git commit` command, or on a later line than its `git commit` (after a commit message in a
  here document); a `GIT_CONFIG_*` variable carrying a hook key; a skip variable set through a wrapper
  (`env HUSKY=0 git commit`), set on an earlier line unless that line holds only assignments and the next line starts
  with git (`export HUSKY=0`, then `make`, then `git commit`, one per line), or set the PowerShell way (`$env:HUSKY = '0'; git commit`,
  `Set-Item env:HUSKY 0; git commit`); and editing `.git/hooks` or `.git/config`.
- Other programs that publish: `git send-pack`, `git http-push`, `git subtree push`, `pull`, or `merge`,
  `gh pr create` or `comment`, and `gh api`.
- Identity it cannot tell: a nested `claude -p` started from a subagent's shell has no `agent_id`, so it is
  treated as a main session; a child that holds the Agent tool (the built-in `general-purpose`) can launch an
  `autopilot-owner` grandchild, which may publish; and `agent_id` for teammates is documented but not observed.
- Other tools: MCP tools that run commands.
- Any command when the guard file is absent: the hook allows the call without running the guard when
  `agentic/tools/git-guard/cli.ts` is missing from the agent-kit checkout, or the checkout is missing.

## Check changes

```sh
bun scripts/check-skills.ts
bun test claude/tests
```

`claude/tests/runtime.test.ts` runs only when a `claude` CLI is on PATH. It loads the Mod into a disposable
profile and runs native `/changes` and `/validate` with zero model usage. For typechecking, load the Mod once
with `claude --plugin-dir claude/mods/trial-tools` to generate `.claude-plugin/types/` for the installed
version, then run `tsc -p claude/mods/trial-tools --noEmit`.
