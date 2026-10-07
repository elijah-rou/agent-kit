# CLI, TUI, and installer recipe

Adapted from cursor-team-kit `control-cli` (MIT). Use it to fill in the Drive and Evidence sections for a terminal surface.

## Choose the harness

1. Reuse the repository's own harness first: package scripts, end-to-end tests, expect scripts, PTY helpers, demo recorders, container test scripts.
2. Non-interactive commands need no terminal emulation: run them directly and capture command, stdout, stderr, and exit code.
3. Interactive programs and TUIs need a real terminal: tmux when available, otherwise a short PTY script.
4. Installers and anything that changes the machine run inside a disposable container or VM, never on the host. Name the container per run and record its ID for cleanup.

## tmux harness

Give each drive its own session name and kill only that session.

```sh
session="verify-$RUN_ID"
tmux new-session -d -s "$session" -x 120 -y 40 -- <command-under-test>
tmux capture-pane -pt "$session" > "$EVIDENCE_DIR/00-start.txt"
tmux send-keys -t "$session" "help" Enter
until tmux capture-pane -pt "$session" | grep -q "<expected prompt>"; do sleep 0.2; done
tmux capture-pane -pt "$session" > "$EVIDENCE_DIR/01-help.txt"
tmux kill-session -t "$session"
```

Bound every wait loop with a deadline in real helpers; the loop above is the shape, not a finished helper.

## PTY harness

When tmux is unavailable, a PTY script gives deterministic waits. Keep it under the verification skill's `scripts/` only if it becomes a shipped helper.

```python
import os, pty, select, subprocess, sys, time

def expect(fd, needle, deadline):
    buffer = b""
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.25)
        if ready:
            buffer += os.read(fd, 4096)
            if needle in buffer:
                return buffer
    sys.exit(f"timed out waiting for {needle!r}")

primary, secondary = pty.openpty()
proc = subprocess.Popen(["<command>"], stdin=secondary, stdout=secondary, stderr=secondary, close_fds=True)
os.close(secondary)
print(expect(primary, b"<ready text>", time.time() + 30).decode(errors="replace"))
os.write(primary, b"help\n")
print(expect(primary, b"<expected output>", time.time() + 30).decode(errors="replace"))
proc.terminate()
proc.wait(timeout=10)
os.close(primary)
```

## Interaction rules

- Capture the screen before the first action.
- Send one action at a time: text, Enter, arrows, Escape, Ctrl-C, or a resize.
- Wait for a concrete screen pattern or prompt before the next action. If a sleep is unavoidable, say why in the skill.
- Set deterministic environment: locale, `TERM`, terminal size, `NO_COLOR` or a fixed color mode, a temporary `HOME` when the program writes config.

## Evidence

- The command line, stdout, stderr, and exit code for each step.
- Screen captures before and after each interactive action.
- Side effects observed separately: files written, installed state, records in a state file, processes left running.
- For an installer: install, a rerun (idempotence), the health or doctor command, and uninstall, each with its observed end state.

## Profiling recipes

- **Startup time:** baseline and treatment on the same machine, environment, and command, several runs each, reporting spread as well as the median.
- **Slow operation:** CPU profile around the operation; compare top self-time functions.
- **Memory growth:** force GC if available, snapshot, repeat the operation, force GC, snapshot again.
- **Hang:** capture the screen, open handles, and a stack or CPU sample before interrupting.

## Guardrails

- Never send credentials or destructive commands into a controlled session.
- Keep throwaway harnesses in a temporary directory unless the repository already has a harness location.
- Cleanup kills the sessions, containers, and inspector processes this run started, and keeps the transcripts.
