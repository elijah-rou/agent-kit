# Tally verification map

This directory is the maintained recipe book for verifying what users of Tally, a small task tracker, can see and do. Read this index first, then follow the feature file that matches the behavior under test.

## Baseline preconditions

- Start Tally with `tally serve --port 5190 --data /tmp/tally-verify-$RUN_ID`.
- Seed two tasks: `Water plants` (open) and `File taxes` (done).
- Put `drive-tally` and the `tally` CLI on `PATH`.
- Run `drive-tally doctor` and require the expected port, data directory, and version.
- Only drive an instance this run started.

## Driving conventions

- Begin each recipe from the baseline state unless its preconditions say otherwise.
- Select page elements by role and accessible name, never by CSS class.
- Run page actions through `drive-tally page` and terminal actions through `drive-tally sh -- <command>`.
- Undo any data change after the recipe, but keep its proof files.

## Proof and skip reporting

- Record the action taken and the state it produced.
- Page proof is an accessibility snapshot plus a screenshot that shows the Tally header.
- Terminal proof is the command, its stdout and stderr, and its exit code.
- When an entry point cannot be reached, report the command tried and the missing precondition.
- Never report a skipped entry point as verified by way of another one.

## Feature entry contract

Each feature file opens with an H1 and a paragraph, then has exactly four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`.

## Features

- [Add a task](./add-task.md) covers page and terminal creation, validation, and persistence.
- [Complete a task](./complete-task.md) covers checking off, undoing, and the done filter.
