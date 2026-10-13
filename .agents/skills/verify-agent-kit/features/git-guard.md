# Git guard

Before Claude Code runs a shell command through Bash, Monitor, or PowerShell, agent-kit's PreToolUse hook checks it against the git policy Pi's `git-interceptor` also applies. Any session that skips git hooks (`--no-verify`, `git commit -n`, a `core.hooksPath` override) gets a refusal naming what to do instead, and so does a subagent that pushes, pulls, merges, rebases, cherry-picks, reverts, applies a patch, tags, or runs `gh pr merge`, unless it runs as an `autopilot-owner`. The main session may publish. An event or command the hook cannot read is refused rather than let through, and the guard also refuses some commands it need not, mostly mentions of a refused command in a quoted message or search; each such refusal names how to rephrase (see Gotchas).

## Sub-features

- `main-push` lets the main session publish.
- `main-no-verify` and `main-commit-n` refuse skipping hooks in the main session, and so do `main-heredoc-no-verify` (a flag after a here document in a substitution) and `main-redirected-commit-n` (a redirection before git).
- `main-hooks-path` refuses `git config core.hooksPath <dir>` with a reason that sends it to the user.
- `main-mention` refuses a commit message that mentions `--no-verify` with a reason that says it may be a mention and names `git commit -F <file>`; `main-commit-file` lets `git commit -F <file>` through.
- `main-unreadable` refuses a command with an unclosed quote.
- `subagent-push`, `subagent-rebase`, and `subagent-absolute-git` refuse publication and integration in a subagent, including after `cd`, past `-C`, and through an absolute path to git.
- `subagent-gh-merge` refuses `gh pr merge` in a subagent.
- `subagent-monitor-push` refuses a push run through the Monitor tool, and `subagent-powershell-escape` one through PowerShell spelled with its backtick escape.
- `subagent-redirected-push`, `subagent-env-split`, and `subagent-subtree-push` refuse a push behind a redirection, inside `env -S'...'`, and through `git subtree push`.
- `subagent-merge-base` and `subagent-tag-list` let a subagent run `git merge-base` and list tags.
- `subagent-local` lets a subagent commit locally, and `subagent-not-git` lets it run a command that is not git.
- `subagent-write` lets a tool that runs no command through, even with git text in its input.
- `owner-push` lets an `autopilot-owner` subagent push its own branch, and `owner-no-verify` refuses it skipping hooks.
- `malformed` refuses an event that is not JSON.
- `project-bunfig` shows the deny holds in a project whose `bunfig.toml` preload prints, when the hook runs with `bun --cwd <kit>` as documented.
- `usage` makes a call without `--claude-hook` a usage error with no decision.

## How to get to it (user POV)

- Not yet: bootstrap does not wire the hook (a pending bootstrap change), so no Claude Code session runs it today. Once wired, any Bash, Monitor, or PowerShell command in Claude Code, in the main session or a subagent, in any permission mode including bypass, runs `bun --cwd <kit> <kit>/agentic/tools/git-guard/cli.ts --claude-hook` with the event on stdin (the entry is in `claude/README.md`).
- A refused command shows the hook's reason as the tool's error, and the command does not run.

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID git-guard`.
- Doctor passed. The drive needs nothing optional: no `gh` login, key, or `claude` CLI.

- **Project.** The drive makes a scratch git repository, `git-guard-project/`, whose `bunfig.toml` preloads a script that prints `project preload ran`, and runs every case from it with `bun --cwd <checkout> <checkout>/agentic/tools/git-guard/cli.ts --claude-hook`. A control step runs the hook there without `--cwd` and checks that the preload's line reaches stdout, so the fixture is shown to bite.
- **Main session.** An event without `agent_id` running `git push origin main`: exit 0 and empty stdout. `git commit --allow-empty --no-verify -m probe`, `git commit -nm probe`, `git commit -m "$(cat <<'EOF' ... EOF)" --no-verify` with an apostrophe in the body, and `2>/dev/null git commit -n -m x`: a deny naming skipping git hooks. `git config core.hooksPath .githooks`: a deny saying to ask the user. `git commit -m "docs: explain why --no-verify is refused"`: a deny saying it may only mention the flag and naming `git commit -F <file>`. `git commit -F .git/COMMIT_MSG_DRAFT`: empty stdout. `git commit -m "unterminated`: a deny saying the hook could not read the command.
- **Subagent.** Events with `agent_id` and `agent_type: general-purpose`: `git push origin agent/x`, `cd sub && git -C . rebase origin/main`, `/usr/bin/git push`, and `gh pr merge 28 --squash` are denied as `child publication/integration command: git push`, `git rebase`, `git push`, and `gh pr merge`; the Monitor tool's `git push origin agent/x`, PowerShell's ``git pu`sh origin x``, `>/dev/null git push origin x`, `env -S'git push origin x'`, and `git subtree push --prefix=d origin x` are denied the same way (the last as `git subtree push`); `git merge-base HEAD origin/main` and `git tag -l` print nothing; `git commit -m local` and `ls -la` print nothing; a Write tool whose content is `git push --no-verify` prints nothing.
- **Owner.** Events with `agent_type: autopilot-owner`: `git push --force-with-lease=agent/x:abc origin agent/x` prints nothing, and `git commit --no-verify -m x` is denied.
- **Malformed.** Stdin `not json`: exit 0 and a deny saying the hook could not read the PreToolUse event.
- **Usage.** No flag: exit 2 and empty stdout.
- **Proof.** Each deny is checked to be exactly `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": ...}}`, and the scratch repository the cases run in still has no commit afterwards, so the hook ran none of the commands. Evidence: `git-guard/NN-hook-*.txt` with each event on stdin and the hook's output.

## Gotchas

- This drive pipes events to the hook; it does not start Claude Code. That Claude Code honors the deny in bypass-permission mode, sends `agent_id` and `agent_type` from a subagent, and routes Monitor commands through the hook comes from the hooks documentation and headless runs recorded in the pull request that added the hook, not from this drive.
- Claude Code lets a tool call through when a hook cannot start, times out, or exits other than 0 or 2, unless the hook entry sets `"onFailure": "block"` (honored from Claude Code 2.1.295); the documented entry sets it, and this drive does not observe it. Before 2.1.295 the guard fails open on those failures.
- What the guard refuses that it need not (the same list is in ADR 0001 and `claude/README.md`): mentions, because its text patterns see a git command at the start of any line, even in a quoted commit message, a here document, or a search pattern, and the reason then says to commit such a message from a file with `git commit -F <file>` or to search without the leading dashes; a child's harmless uses of a refused subcommand, such as `git rebase --abort`; `git config core.hooksPath <dir>` for every session, even to turn on a repository's hooks directory, which the user sets instead; and any command its reader cannot read (an unclosed quote, substitution, or here document, nesting past 8 levels, a glob or brace in a program name, an `-EncodedCommand` that is not base64 of UTF-16LE).
- What the guard does not stop (the same list is in ADR 0001 and `claude/README.md`): commands it cannot see in the text (a program or command named through a variable or a substitution, a shell alias or function, a script file, a subcommand supplied on stdin, a git or gh alias, PowerShell's `Start-Process`, other programs that run their arguments as a command such as `parallel` or `ssh`, and other programs that publish, such as `gh pr create`, `gh api`, or a script); hooks disabled another way (editing `.git/hooks` or `.git/config`, `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` pointing at a file, a `GIT_CONFIG_*` variable exported by an earlier command, or a tool's own skip variable such as `HUSKY=0`); identity it cannot tell (a nested `claude -p` started from a subagent's shell has no `agent_id` and counts as a main session, a child holding the Agent tool can launch an `autopilot-owner` grandchild, and `agent_id` for teammates is documented but not observed); and MCP tools that run commands. No case here claims otherwise.
- `agent_type` alone does not mark a subagent: Claude Code also sends it for a main session started with `--agent`. The hook treats an event as a subagent's only when it carries `agent_id`.
