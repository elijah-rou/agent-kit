# Notes verification map

This directory is the maintained source for verifying what users of Notes can do. Read this index before driving the app, then use the matching feature file as the recipe.

This is an example for a fictional app with a browser and a CLI surface. Copy its shape, not its commands.

## Baseline preconditions

- Notes runs at `http://127.0.0.1:4173`, started by this run, with `NOTES_DATA_DIR=$TMPDIR/notes-verify-$RUN_ID` so concurrent runs never share state.
- The data directory is seeded with notes titled `Quarterly plan` (body `Draft budget`) and `Grocery list`.
- `notes-harness` and the `notes` CLI are on `PATH`.
- `notes-harness doctor` reports the expected URL, data directory, and build revision.
- Evidence goes to `$EVIDENCE_DIR/<feature-id>/`, which cleanup never touches.
- Never drive an instance this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Target elements by role and accessible name, not CSS selectors or position.
- Treat every command literally; keep quoted names and flags exactly as written.
- Browser actions go through `notes-harness browser`; terminal actions through `notes-harness cli -- <command>`.
- Restore seeded data after a mutation. Never delete evidence during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Browser proof is an accessibility snapshot plus a screenshot with the app identity visible.
- CLI proof is the command, stdout, stderr, and exit code.
- A mutation is proved by a second, read-only view of the stored value.
- Every artifact records the feature ID and the entry point used.
- An unreachable entry point is reported with the attempted command and the unmet precondition.
- A skipped entry point is never reported as verified through a different one.

## Feature file contract

Each feature file starts with an H1 title and one paragraph describing the behavior a user sees. It then has exactly four H2 sections, in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every entry point a user has.
3. `Driving it with <harness>`: starts with `Preconditions:`, then labeled bullets pairing each user action with an exact command and its observable result.
4. `Gotchas`: traps that waste or invalidate a run.

Keep implementation details out. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Create a note](./create-note.md): browser and CLI creation, cancelling a draft, persistence.
- [Search notes](./search.md): toolbar, keyboard, and CLI search, with match, empty, and cleared states.
