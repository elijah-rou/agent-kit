# Prompt routing

Every prompt typed in Claude Code or Codex passes through agent-kit's UserPromptSubmit hook. The hook never blocks the prompt: it screens it, asks Jev to classify a real task, appends one record without the prompt's text to the task-route ledger, and answers with a note only when a calibrated note applies. Prompts that are not tasks, that the runtime started itself, that carry credential-shaped text, or that come from an opted-out repository are recorded without any request.

## Sub-features

- `route-off` records a prompt and makes no request when `AGENTIC_ROUTE=off`.
- `route-not-a-task` records a short reply such as `ok` as not a task.
- `route-system` records a turn the runtime started (a task notification) as `system`.
- `route-unsafe` withholds a prompt with credential-shaped text.
- `route-opt-out` withholds every prompt from a repository holding `.agents/jev-opt-out`.
- `route-codex` writes the Codex hook's record under the `codex` runtime.
- `route-jev` classifies a real task with Jev and records both answers.
- `route-manual` prints a typed task's route without recording it.

## How to get to it (user POV)

- Type any prompt in Claude Code; bootstrap's `settings.json` runs `bun <kit>/agentic/tools/jev/cli.ts task-class --claude-hook` with the event on stdin.
- Type any prompt in Codex; its hook runs the same command with `--codex-hook`.
- Run `agentic jev task-class "<task>"` in a terminal to see a task's route.
- Set `AGENTIC_ROUTE=off` (or `shadow`) for a session, or commit `.agents/jev-opt-out` in a repository.
- Read the records under `$XDG_STATE_HOME/agentic/task-route/<machine>/<runtime>-<session>.jsonl`.

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID task-route`.
- Doctor passed. For `route-jev` and `route-manual`, doctor reports a TypeSafe key; without one the drive checks every offline step and ends with `SKIP`.

- **Off.** The hook runs in `fixture/` with `AGENTIC_ROUTE=off` and a real task. Exit 0, no stdout, one record whose `fallbacks` are exactly `["off"]`, and no `answers`.
- **Not a task.** The prompt `ok`. One record whose `fallbacks` are exactly `["not-a-task"]`, and no `answers`.
- **Runtime turn.** The prompt `<task-notification> task finished`. One record whose `fallbacks` are exactly `["system"]`, and no `answers`.
- **Credential-shaped text.** A prompt holding a `token=` assignment. One record whose `fallbacks` are exactly `["unsafe-input"]`, and no `answers`.
- **Opted out.** The real task from `fixture-optout/`. One record whose `fallbacks` are exactly `["opted-out"]`, with `optedOut: true` and no `answers`. A request that was sent and failed would show a different fallback.
- **Codex.** The off case through `--codex-hook`. The record file is `codex-<session>.jsonl`.
- **Jev.** The real task with routing on. Exit 0, one record whose only fallbacks are routing decisions (`low-confidence`, `conflict`, `model-drift`), never a failed request, and whose `answers` hold a door choice (`reversible`, `experiment`, or `one-way-door`), a level choice (`lookup`, `rigor`, or `loop`), and a `jev-` model. A record marked `noted` comes with `hookSpecificOutput.additionalContext` on stdout; otherwise stdout is empty.
- **Manual.** `agentic jev task-class "<task>"` prints a route naming Jev's model with its advised and delivered levels, and adds no file under `state/`.
- **Proof.** Every record holds counts and a digest, never the prompt's text. Evidence: `task-route/NN-hook-*.txt` with each event on stdin and the hook's output, and `records.jsonl` with every record the drive read back.

## Gotchas

- The hook's stdout is the note. An empty stdout is correct while every note is in shadow (`agentic/tools/jev/route.ts`); a note appears only after a note's policy becomes advisory.
- An inherited `AGENTIC_ROUTE` from the shell would change every case; the drive sets it explicitly for each step.
- The opt-out check is the file's presence at the checkout root, committed or not, although the help text says "commits".
- The Jev steps make two real TypeSafe requests per run (the hook and the manual route). Classifications can differ between runs; only their shape is checked.
- The records' `launcher` field reflects the environment the CLI runs in (for example `t3` inside T3 Code).
