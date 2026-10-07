# Complete a task

Complete task lets a user mark an open task done, undo that, and filter the list to finished tasks.

## Sub-features

- `complete-check` marks a task done.
- `complete-undo` reopens a done task.
- `complete-filter` shows only done tasks.

## How to get to it (user POV)

- Tick the checkbox beside a task on the main page.
- Run `tally done <id>` in a terminal.

## Driving it with drive-tally

**Preconditions:** `Water plants` is open and `File taxes` is done.

### Page

- **Check off.** Run `drive-tally page check --role checkbox --name "Water plants"`. The task moves to `Done tasks`.
- **Undo.** Run `drive-tally page uncheck --role checkbox --name "Water plants"`. The task returns to `Open tasks`.

### Terminal

- **Done filter.** Run `drive-tally sh -- tally list --done --json`. Stdout holds exactly `File taxes`.

```sh
# A heading-like line inside a code block is not a section:
## Not a section
```

## Gotchas

- Undo is only offered for ten seconds after checking a task off on the page.
