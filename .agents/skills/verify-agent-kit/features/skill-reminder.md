# Skill reminder

Before Claude Code runs a tool that edits a file (Edit, MultiEdit, Write, or NotebookEdit), agent-kit's PreToolUse hook checks whether the file is source code by its extension. The first source edit in a session, and the first in each subagent, gets a reminder to load the `code-design` skill and check the edit against it, delivered as context next to the tool's result. Later source edits, and edits to prose or configuration files, get nothing. The hook never refuses an edit: an event it cannot read, a tool that edits no file, or a failure prints nothing and the edit goes ahead.

## Sub-features

- `main-markdown` and `main-config` print nothing for an edit to `README.md` and a write of `package.json`, and leave the reminder for the first source edit.
- `main-first-source` reminds on the main session's first `.ts` edit, and `main-second-source` prints nothing for its next source edit, a MultiEdit of a `.py` file.
- `subagent-first-source` reminds a subagent on its first source write even though the main session was already reminded, and `subagent-second-source` prints nothing for its next.
- `subagent-notebook` reminds on a NotebookEdit of an `.ipynb` file, which names its file in `notebook_path`.
- `main-bash` prints nothing for a tool that edits no file, even with a source file name in its command.
- `malformed` prints nothing for an event that is not JSON.
- `markers` shows each session and subagent kept its own marker under `XDG_STATE_HOME/agentic/skill-reminder/<session>/`.
- `project-bunfig` shows the reminder survives a project whose `bunfig.toml` preload prints, when the hook runs with `bun --cwd <kit>` as documented.
- `usage` makes a call without `--claude-hook` exit 1 with no output, which Claude Code treats as a non-blocking error.

## How to get to it (user POV)

- In a Claude Code install whose `settings.json` holds the skill reminder's PreToolUse entry (`claude/README.md`, Install), the first file edit to a source file in a session or subagent runs `bun --cwd <kit> <kit>/agentic/tools/skill-reminder/cli.ts --claude-hook` with the event on stdin, and the agent sees the reminder beside the edit's result. A session without that entry gets no reminder.

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID skill-reminder`.
- Doctor passed. The drive needs nothing optional: no `gh` login, key, or `claude` CLI.

- **Project.** The drive makes a scratch directory, `skill-reminder-project/`, whose `bunfig.toml` preloads a script that prints `project preload ran`, and runs every case from it with `bun --cwd <checkout> <checkout>/agentic/tools/skill-reminder/cli.ts --claude-hook` and a fresh `XDG_STATE_HOME` per drive under the run directory (`skill-reminder-state-*`), so a rerun starts with no markers. A control step runs the hook there without `--cwd` and checks that the preload's line reaches stdout, so the fixture is shown to bite.
- **Cases.** In order, against one state directory: an Edit of `README.md` and a Write of `package.json` print nothing; an Edit of `a.ts` prints the reminder; a MultiEdit of `b.py` prints nothing; a subagent's (`agent_id: a-verify-worker`) Write of `c.rs` prints the reminder and its Edit of `c.rs` prints nothing; another subagent's NotebookEdit of `n.ipynb` prints the reminder; a Bash command `vim a.ts` and stdin `not json` print nothing. Every case exits 0.
- **Usage.** No flag: exit 1 and empty stdout.
- **Proof.** Each reminder is checked to be exactly `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": ...}}`, with no permission decision, and its text names `code-design` and says to load it now; the state directory holds one marker each for the main session and both subagents. Evidence: `skill-reminder/NN-hook-*.txt` with each event on stdin and the hook's output.

## Gotchas

- This drive pipes events to the hook; it does not start Claude Code. That Claude Code delivers a PreToolUse hook's `additionalContext` without a permission decision, once, beside the first edit's result, comes from a headless `claude -p` run recorded in the pull request that added the hook, not from this drive.
- The reminder arrives after the first source edit has run, beside its result, so the agent checks that edit against `code-design` after the fact.
- Source is decided by file extension; a source file without one, such as a script named `validate`, gets no reminder.
