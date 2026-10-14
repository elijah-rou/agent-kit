# Prompt routing

Every prompt typed in Claude Code passes through agent-kit's UserPromptSubmit hook. The hook never blocks the prompt: it screens it, asks Jev to classify a real task, appends one record without the prompt's text to the task-route ledger, and answers with a note as added context when a delivered note applies: since policy `task-route@2` every note is delivered on trial, before any calibration (`POLICY` in `agentic/tools/jev/route.ts`). `agentic jev route-report` reads the ledger back to show how each note fared. Prompts that are not tasks, that the runtime started itself, that carry credential-shaped text, or that come from an opted-out repository are recorded without any request.

## Sub-features

- `route-off` records a prompt and makes no request when `AGENTIC_ROUTE=off`.
- `route-not-a-task` records a short reply such as `ok` as not a task.
- `route-system` records a turn the runtime started (a task notification) as `system`.
- `route-unsafe` withholds a prompt with credential-shaped text.
- `route-opt-out` withholds every prompt from a repository holding `.agents/jev-opt-out`.
- `route-codex-refused` checks that the removed `--codex-hook` flag is a usage error that writes no record.
- `route-jev` classifies a real task with Jev and records both answers.
- `route-manual` prints a typed task's route without recording it.
- `route-report` reports the recorded routes per note and runtime, and joins correction records by session.

## How to get to it (user POV)

- Type any prompt in Claude Code; bootstrap's `settings.json` runs `bun <kit>/agentic/tools/jev/cli.ts task-class --claude-hook` with the event on stdin.
- Run `agentic jev task-class "<task>"` in a terminal to see a task's route.
- Set `AGENTIC_ROUTE=off` (or `shadow`) for a session, or commit `.agents/jev-opt-out` in a repository.
- Read the records under `$XDG_STATE_HOME/agentic/task-route/<machine>/<runtime>-<session>.jsonl`.
- Run `agentic jev route-report [--days <n>] [--policy <id>] [--json]` in a repository to see how each note fared.

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID task-route`.
- Doctor passed. For `route-jev` and `route-manual`, doctor reports a TypeSafe key; without one the drive checks every offline step, `route-report` included, and ends with `SKIP`.

- **Off.** The hook runs in `fixture/` with `AGENTIC_ROUTE=off` and a real task. Exit 0, no stdout, one record whose `fallbacks` are exactly `["off"]`, and no `answers`.
- **Not a task.** The prompt `ok`. One record whose `fallbacks` are exactly `["not-a-task"]`, and no `answers`.
- **Runtime turn.** The prompt `<task-notification> task finished`. One record whose `fallbacks` are exactly `["system"]`, and no `answers`.
- **Credential-shaped text.** A prompt holding a `token=` assignment. One record whose `fallbacks` are exactly `["unsafe-input"]`, and no `answers`.
- **Opted out.** The real task from `fixture-optout/`. One record whose `fallbacks` are exactly `["opted-out"]`, with `optedOut: true` and no `answers`. A request that was sent and failed would show a different fallback.
- **Codex refused.** The real task through `--codex-hook`, which agent-kit no longer supports. Exit 2 with the usage text on stderr, no stdout, and no new file under the task-route ledger.
- **Report.** After the withheld steps and before the Jev steps, so it runs without a key: one correction record for the not-a-task step's session goes into `fixture/.git/agentic/corrections/`. `agentic jev route-report --json` in `fixture/` exits 0 with a 7-day window, reads exactly the records the drive wrote, all under the shown policy with no other mixed in, shows claude as the only runtime with its five fallbacks, decides no note, joins the correction into the `no note` group, and prints no correction text. The table form with `--days 1` names its one-day window and the correlation caveat, `--days 0` exits 2, and no report step adds a file under `state/`.
- **Jev.** The real task with routing on. Exit 0, one record whose only fallbacks are routing decisions (`low-confidence`, `conflict`, `model-drift`), never a failed request, and whose `answers` hold a door choice (`reversible`, `experiment`, or `one-way-door`), a level choice (`lookup`, `rigor`, or `loop`), and a `jev-` model. A record marked `noted` comes with `hookSpecificOutput.additionalContext` on stdout; otherwise stdout is empty.
- **Manual.** `agentic jev task-class "<task>"` prints a route naming Jev's model with its advised and delivered levels, and adds no file under `state/`.
- **Proof.** Every record holds counts and a digest, never the prompt's text. Evidence: `task-route/NN-hook-*.txt` with each event on stdin and the hook's output, `task-route/NN-route-report-*.txt` with the report's output, and `records.jsonl` with every record the drive read back.

## Gotchas

- The hook's stdout is the note. Since policy `task-route@2` every note is delivered on trial, so the Jev step's real task often gets the door note; a note in shadow, a session with `AGENTIC_ROUTE=shadow`, or a record not marked `noted` leaves stdout empty.
- An inherited `AGENTIC_ROUTE` from the shell would change every case; the drive sets it explicitly for each step.
- The opt-out check is the file's presence at the checkout root, committed or not, although the help text says "commits".
- The Jev steps make two real TypeSafe requests per run (the hook and the manual route); the report makes none. Classifications can differ between runs; only their shape is checked.
- The records' `launcher` field reflects the environment the CLI runs in (for example `t3` inside T3 Code).
