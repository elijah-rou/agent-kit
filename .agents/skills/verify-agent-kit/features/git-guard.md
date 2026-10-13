# Git guard

Before Claude Code runs a Bash command, agent-kit's PreToolUse hook checks it against the git policy Pi's `git-interceptor` also applies. Any session that runs a git command with `--no-verify` gets a refusal naming what to do instead, and so does a subagent that pushes, pulls, merges, rebases, cherry-picks, reverts, applies a patch, or tags, unless it runs as an `autopilot-owner`. The main session may publish. Every other command runs as before, and an event the hook cannot read is refused rather than let through.

## Sub-features

- `main-push` lets the main session publish.
- `main-no-verify` refuses `--no-verify` in the main session.
- `subagent-push` and `subagent-rebase` refuse publication and integration in a subagent, including after `cd` and past `-C`.
- `subagent-local` lets a subagent commit locally.
- `owner-push` lets an `autopilot-owner` subagent push its own branch.
- `owner-no-verify` refuses `--no-verify` for an owner too.
- `subagent-not-git` lets a subagent run a command that is not git.
- `malformed` refuses an event that is not JSON.
- `usage` makes a call without `--claude-hook` a usage error with no decision.

## How to get to it (user POV)

- Run any Bash command in Claude Code, in the main session or a subagent, in any permission mode including bypass; bootstrap's `settings.json` runs `bun <kit>/agentic/tools/git-guard/cli.ts --claude-hook` with the event on stdin (see `claude/README.md`).
- A refused command shows the hook's reason as the tool's error, and the command does not run.

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID git-guard`.
- Doctor passed. The drive needs nothing optional: no `gh` login, key, or `claude` CLI.

- **Main session.** An event without `agent_id` running `git push origin main`: exit 0 and empty stdout. The same event running `git commit --allow-empty --no-verify -m probe`: exit 0 and a deny naming `--no-verify`.
- **Subagent.** Events with `agent_id` and `agent_type: general-purpose`: `git push origin agent/x` and `cd sub && git -C . rebase origin/main` are denied as `child publication/integration command: git push` and `git rebase`; `git commit -m local` and `ls -la` print nothing.
- **Owner.** Events with `agent_type: autopilot-owner`: `git push --force-with-lease=agent/x:abc origin agent/x` prints nothing, and `git commit --no-verify -m x` is denied.
- **Malformed.** Stdin `not json`: exit 0 and a deny saying the hook could not read the PreToolUse event.
- **Usage.** No flag: exit 2 and empty stdout.
- **Proof.** Each deny is checked to be exactly `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": ...}}`, and the scratch repository the events name as `cwd` still has no commit afterwards, so the hook ran none of the commands. Evidence: `git-guard/NN-hook-*.txt` with each event on stdin and the hook's output.

## Gotchas

- This drive pipes events to the hook; it does not start Claude Code. That Claude Code honors the deny in bypass-permission mode, and sends `agent_id` and `agent_type` from a subagent, comes from the hooks documentation and a one-off headless run recorded in the pull request that added the hook, not from this drive.
- Claude Code lets a tool call through when a hook cannot start, times out, or exits other than 0 or 2, unless the hook entry sets `"onFailure": "block"`; bootstrap's wiring sets it, and this drive does not observe it.
- The guard matches command text. A git command it does not recognize, such as one behind `env`, a `-c` option, or a subshell, passes; no case here claims otherwise.
- `agent_type` alone does not mark a subagent: Claude Code also sends it for a main session started with `--agent`. The hook treats an event as a subagent's only when it carries `agent_id`.
