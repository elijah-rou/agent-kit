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
`git commit -n` or `git am -n`, a `-c` or `GIT_CONFIG_*` override of `core.hooksPath` or a `hook.*` key, or
a hook manager's skip variable (`HUSKY`, `HUSKY_SKIP_HOOKS`, `SKIP`, `PRE_COMMIT_ALLOW_NO_CONFIG`,
`LEFTHOOK`, `LEFTHOOK_EXCLUDE`, `OVERCOMMIT_DISABLE`) in a command that runs git, set on the git command, on
a program the guard follows into that runs it (`sh -c`, `eval`, `env`, a here document fed to a shell, and
the other wrappers), as a standalone assignment, through `export`, `declare`, `typeset`, `local`, or
`readonly`, or with PowerShell's `$env:NAME =`) in every session, and refuses `git push`, `pull`, `merge`,
`rebase`, `cherry-pick`, `revert`, `am`, `apply`, `tag` (except listing or verifying tags), `send-pack`,
`http-push`, `git subtree push`, `pull`, and `merge`, and `gh pr merge` inside a subagent (an event carrying
`agent_id`) unless its `agent_type` is `autopilot-owner`. The main session may publish. It denies with
Claude Code's JSON decision, which holds in bypass-permission mode too, and allows by printing nothing. An
event it cannot read is denied.

What it refuses that it need not (the same list is in ADR 0001 and the verify-agent-kit `git-guard` feature):

- Mentions. Two readers decide, and either refusing refuses: text patterns that see a git command at the
  start of any line, even inside a quoted commit message, a here document, or a search pattern, and a
  command reader that reads what the shell would run. When only the patterns refuse, the reason says the
  text may be a mention: commit such a message from a file (write it with the editor tool, then
  `git commit -F <file>`), and search for `--no-verify` without its leading dashes.
- A child's harmless uses of a refused subcommand, such as `git rebase --abort`.
- A skip variable set alone or exported in a command whose git command runs no hooks, such as
  `export SKIP=lint; git log`.
- `git config` changes to `core.hooksPath` or any `hook.*` key (git's config-based hooks), for every
  session, even to turn on a repository's own hooks, and unsetting `core.hooksPath` (which turns a husky
  repository's hooks off): ask the user to change them. Reading them passes.
- A command the reader cannot read, for every session: an unclosed quote, substitution, or here document,
  nesting past 8 levels, a glob or brace in a program name or in git's or gh's subcommand or option words,
  a PowerShell `-EncodedCommand` that is not base64 of UTF-16LE, and commands fed to a shell (or to
  `Invoke-Expression`) from anything but a here document, a here-string, or `cat <<EOF |`, such as
  `printf ... | sh`, `curl ... | sh`, `bash <(...)`, or `source <(...)`; a shell started with no input
  (`bash -l`, `exec zsh`); a single-quoted span holding `}` or `"` inside a double-quoted `${...}`, which
  bash and zsh read differently; a PowerShell option abbreviation that could name two options (`-in`); a
  PowerShell value option whose value names `-Command`, `-EncodedCommand`, or `-File` (`-wd /c`); a `wsl`
  argument holding spaces or quotes without `-e` (wsl joins its words into one line); `wsl -e` running a
  shell that reads its input; a `[[ ]]` holding a process substitution or `$'...'`, or followed by a
  redirection; a PowerShell assignment whose value is read as a program, so a quoted value naming a shell
  (`$m = 'Switch the hook to /bin/sh'`) reads as starting that shell; an `@"..."@` here-string whose body
  holds a `"`, or that the double-quote reader does not read up to its own closing `"@`; a lone carriage
  return in PowerShell, which it reads as a line break; and any curly quote in a PowerShell command, which its
  tokenizer reads as a quote. The
  reason asks for a plainer command; a shell given a script operand reads its input as data and passes.

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

- Commands that appear only after expansion or evaluation. The reader follows common shell syntax, so a
  command whose program or arguments appear only after expansion or evaluation can get past it: parameter
  expansion (`$x push`), arithmetic, brace or glob expansion in git's operands, unusual quoting or syntax
  forms, shell aliases and functions, git and gh aliases, script files, and programs that run their
  arguments or input as commands beyond the wrappers it follows (for example `parallel`, `ssh`, `trap`,
  `xargs git` with the subcommand on stdin, a Python script, PowerShell's `Start-Process`). So can other
  programs that publish (`gh pr create` or `comment`, `gh api`). Anything it cannot read is refused.
- Hooks disabled another way: editing `.git/hooks` or `.git/config` (or a file it includes),
  `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` pointing at a file, a `GIT_CONFIG_*` variable exported by an
  earlier command, or a skip variable of a hook manager the guard does not list (it refuses `HUSKY`,
  `HUSKY_SKIP_HOOKS`, `SKIP`, `PRE_COMMIT_ALLOW_NO_CONFIG`, `LEFTHOOK`, `LEFTHOOK_EXCLUDE`, and
  `OVERCOMMIT_DISABLE`).
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
