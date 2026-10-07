# Add a task

Add task lets a user record a new open task from the page or the terminal and see it in the task list afterwards.

## Sub-features

- `add-page` creates a task from the page form.
- `add-cli` creates a task from the terminal.
- `add-empty` rejects an empty title.

## How to get to it (user POV)

- Type into the `New task` textbox on the main page and press Enter.
- Run `tally add <title>` in a terminal.

## Driving it with drive-tally

Preconditions:

- Tally answers on port 5190.
- No task is titled `Buy stamps`.

- **Page entry.** Run `drive-tally page fill --role textbox --name "New task" --value "Buy stamps"` and `drive-tally page press --key Enter`. The `Open tasks` list shows `Buy stamps`.
- **Empty title.** Run `drive-tally page press --key Enter` with the textbox empty. An alert named `Title required` appears and the list is unchanged.
- **Terminal entry.** Run `drive-tally sh -- tally add "Call bank" --json`. Exit code `0`; stdout holds the new task ID.
- **Proof.** Run `drive-tally page snapshot --path artifacts/add-task/list.txt`. The snapshot lists both new tasks.

## Gotchas

- Leading and trailing spaces are trimmed; assert the rendered title.
- The list refreshes after a short delay. Wait for the list item, not a fixed sleep.
