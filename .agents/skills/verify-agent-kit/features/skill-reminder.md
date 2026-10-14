# Skill reminder

Before Claude Code runs a tool that edits a file (Edit, MultiEdit, Write, or NotebookEdit), agent-kit's PreToolUse hook reminds the agent, on the first file edit in a session and the first in each subagent, to load the `code-design` skill before it edits code in that session, and at once if this edit was to code, delivered as context next to the tool's result. Any file counts, with or without an extension: whether it is code is the agent's call, since no list of extensions fits every project. Later edits get nothing. The hook never refuses an edit: an event it cannot read, a tool that edits no file, or a failure prints nothing and the edit goes ahead.

## Sub-features

- `main-bash` prints nothing for a tool that edits no file, even with a file name in its command, and leaves the reminder for the first edit.
- `main-first-edit` reminds on the main session's first edit, of `README.md`: the hook does not judge file types. `main-second-edit` and `main-config` print nothing for its next edits, a MultiEdit of `a.ts` and a Write of `package.json`.
- `subagent-first-edit` reminds a subagent on its first edit, a Write of an extensionless script `validate`, even though the main session was already reminded, and `subagent-second-edit` prints nothing for its next.
- `subagent-notebook` reminds on a NotebookEdit of an `.ipynb` file, which names its file in `notebook_path`.
- `malformed` prints nothing for an event that is not JSON.
- `markers` shows each session and subagent kept its own marker under `XDG_STATE_HOME/agentic/skill-reminder/<session>/`.
- `project-bunfig` shows the reminder survives a project whose `bunfig.toml` preload prints, when the hook runs with `bun --cwd <kit>` as documented.
- `usage` makes a call without `--claude-hook` exit 1 with no output, which Claude Code treats as a non-blocking error.

## How to get to it (user POV)

- In a Claude Code install whose `settings.json` holds the skill reminder's PreToolUse entry (`claude/README.md`, Install), the first file edit in a session or subagent runs `bun --cwd <kit> <kit>/agentic/tools/skill-reminder/cli.ts --claude-hook` with the event on stdin, and the agent sees the reminder beside the edit's result. A session without that entry gets no reminder.

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID skill-reminder`.
- Doctor passed. The drive needs nothing optional: no `gh` login, key, or `claude` CLI.

- **Project.** The drive makes a scratch directory, `skill-reminder-project/`, whose `bunfig.toml` preloads a script that prints `project preload ran`, and runs every case from it with `bun --cwd <checkout> <checkout>/agentic/tools/skill-reminder/cli.ts --claude-hook` and a fresh `XDG_STATE_HOME` per drive under the run directory (`skill-reminder-state-*`), so a rerun starts with no markers. A control step runs the hook there without `--cwd` and checks that the preload's line reaches stdout, so the fixture is shown to bite.
- **Cases.** In order, against one state directory: a Bash command `vim a.ts` prints nothing; an Edit of `README.md` prints the reminder; a MultiEdit of `a.ts` and a Write of `package.json` print nothing; a subagent's (`agent_id: a-verify-worker`) Write of `validate` prints the reminder and its Edit of `c.rs` prints nothing; another subagent's NotebookEdit of `n.ipynb` prints the reminder; stdin `not json` prints nothing. Every case exits 0.
- **Usage.** No flag: exit 1 and empty stdout.
- **Proof.** Each reminder is checked to be exactly `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": ...}}`, with no permission decision, and its text names `code-design`, says to load it before editing code in the session, and says to load it now if this edit was to code; the state directory holds one marker each for the main session and both subagents. Evidence: `skill-reminder/NN-hook-*.txt` with each event on stdin and the hook's output.

## Gotchas

- This drive pipes events to the hook; it does not start Claude Code. That Claude Code delivers a PreToolUse hook's `additionalContext` without a permission decision, once, beside the first edit's result, comes from a headless `claude -p` run recorded in the pull request that added the hook, not from this drive.
- The reminder arrives after the first edit has run, beside its result, so the agent checks that edit against `code-design` after the fact.
- The reminder also fires on a first edit to prose or configuration, as one line; it then covers the session's later code edits, and the agent decides which files are code.
