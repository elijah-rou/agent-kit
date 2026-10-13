# Git guard

Before Claude Code runs a shell command through Bash, Monitor, or PowerShell, agent-kit's PreToolUse hook checks it against the git policy Pi's `git-interceptor` also applies: two text patterns kept from Pi's original interceptor, which do not read the command as a shell would. Any session whose command has `--no-verify` after `git` on the same line gets a refusal naming what to do instead, and so does a subagent whose command has a line, or a command after `;`, `&`, or `|`, starting `git push`, `pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `apply`, or `tag` (except listing or verifying tags), optionally after `git -C <path>`, unless it runs as an `autopilot-owner`. The main session may publish. An event the hook cannot read is refused rather than let through. Commands the patterns do not match pass, including non-git commands the guard once refused as unreadable (`printf ... | sh`, `bash -l`, an unclosed quote). The patterns also match a mention of a refused command in a quoted message or search; each refusal says how to rephrase one (see Gotchas).

## Sub-features

- `main-push` lets the main session publish.
- `main-no-verify` refuses `--no-verify` in the main session, and `owner-no-verify` refuses it for an `autopilot-owner`.
- `main-mention` refuses a commit message that mentions `--no-verify` with a reason that says it may be a mention and names `git commit -F <file>`; `main-commit-file` lets `git commit -F <file>` through.
- `main-pipe-to-sh`, `main-shell-no-input`, and `main-unclosed-quote` let `printf 'echo hi\n' | sh`, `bash -l`, and `echo "unterminated` through.
- `subagent-push`, `subagent-rebase`, and `subagent-tag` refuse publication and integration in a subagent, including after `cd` and past `-C`.
- `subagent-monitor-push` and `subagent-powershell-push` refuse a push run through the Monitor and PowerShell tools.
- `subagent-mention` refuses a search whose pattern holds `git push` after a `|`, with a reason that says it may be a mention.
- `subagent-merge-base` and `subagent-tag-list` let a subagent run `git merge-base` and list tags.
- `subagent-local` lets a subagent commit locally, and `subagent-not-git` lets it run a command that is not git.
- `subagent-write` lets a tool that runs no command through, even with git text in its input.
- `owner-push` lets an `autopilot-owner` subagent push its own branch.
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
- **Main session.** An event without `agent_id` running `git push origin main`: exit 0 and empty stdout. `git commit --allow-empty --no-verify -m probe`: a deny naming skipping git hooks. `git commit -m "docs: explain why --no-verify is refused"`: a deny saying the text may only mention the flag and naming `git commit -F <file>`. `git commit -F .git/COMMIT_MSG_DRAFT`, `printf 'echo hi\n' | sh`, `bash -l`, and `echo "unterminated`: empty stdout.
- **Subagent.** Events with `agent_id` and `agent_type: general-purpose`: `git push origin agent/x`, `cd sub && git -C . rebase origin/main`, and `git tag v1` are denied as `child publication/integration command: git push`, `git rebase`, and `git tag`; the Monitor and PowerShell tools' `git push origin agent/x` are denied the same way; `rg "error|git push" docs/` is denied as `git push` with a reason saying the text may only mention the command; `git merge-base HEAD origin/main`, `git tag -l`, `git commit -m local`, and `ls -la` print nothing; a Write tool whose content is `git push --no-verify` prints nothing.
- **Owner.** Events with `agent_type: autopilot-owner`: `git push --force-with-lease=agent/x:abc origin agent/x` prints nothing, and `git commit --no-verify -m x` is denied.
- **Malformed.** Stdin `not json`: exit 0 and a deny saying the hook could not read the PreToolUse event.
- **Usage.** No flag: exit 2 and empty stdout.
- **Proof.** Each deny is checked to be exactly `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": ...}}`, and the scratch repository the cases run in still has no commit afterwards, so the hook ran none of the commands. Evidence: `git-guard/NN-hook-*.txt` with each event on stdin and the hook's output.

## Gotchas

- This drive pipes events to the hook; it does not start Claude Code. That Claude Code honors the deny in bypass-permission mode, sends `agent_id` and `agent_type` from a subagent, and routes Monitor commands through the hook comes from the hooks documentation and headless runs recorded in the pull request that added the hook, not from this drive.
- Claude Code lets a tool call through when a hook cannot start, times out, or exits other than 0 or 2, unless the hook entry sets `"onFailure": "block"` (honored from Claude Code 2.1.295); the documented entry sets it, and this drive does not observe it. Before 2.1.295 the guard fails open on those failures.
- What the guard refuses that it need not (the same list is in ADR 0001 and `claude/README.md`): mentions, because its patterns see a git command at the start of any line or after `;`, `&`, or `|`, even in a quoted commit message, a here document, or a search pattern, and the reason then says to commit such a message from a file with `git commit -F <file>` or to search without the leading dashes or without `git` in front; and a child's harmless uses of a refused subcommand, such as `git rebase --abort`.
- What the guard does not stop (the same list is in ADR 0001 and `claude/README.md`): a git command the patterns do not see in the text (one not at the start of a line or after `;`, `&`, or `|`, such as after leading spaces, as an absolute path, after an assignment, redirection, or keyword, inside a wrapper such as `command`, `env`, `sh -c`, `eval`, or `xargs`, a subshell or substitution, PowerShell's call operator or backtick escapes; git options before the subcommand other than `-C`; `--no-verify` on a later line than its `git`; shell aliases and functions, git and gh aliases, and script files); hooks skipped another way (`git commit -n`, `git am -n`, a prefix of `--no-verify`, an override or `git config` change of `core.hooksPath` or a `hook.*` key, a hook manager's skip variable such as `HUSKY=0` or `SKIP=...`, and editing `.git/hooks` or `.git/config`); other programs that publish (`git send-pack`, `git http-push`, `git subtree push`, `pull`, or `merge`, `gh pr merge`, `gh pr create` or `comment`, and `gh api`); identity it cannot tell in Claude (a nested `claude -p` started from a subagent's shell has no `agent_id` and counts as a main session, a child holding the Agent tool can launch an `autopilot-owner` grandchild, and `agent_id` for teammates is documented but not observed); and MCP tools that run commands. No case here claims otherwise.
- `agent_type` alone does not mark a subagent: Claude Code also sends it for a main session started with `--agent`. The hook treats an event as a subagent's only when it carries `agent_id`.
