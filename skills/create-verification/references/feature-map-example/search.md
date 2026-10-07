# Search notes

A user finds notes by title or body text, opens a result, and can tell "no matches" apart from a search that has not finished.

## Sub-features

- `search-open` opens search from each browser entry point.
- `search-match` returns title and body matches without changing any note.
- `search-open-result` opens a result in the editor.
- `search-empty` shows a finished empty state for a query with no matches.
- `search-clear` clears the query and restores the recent-notes view.
- `search-cli` returns the same matches from a terminal.

## How to get to it (user POV)

- Choose `Search` in the browser toolbar.
- Press `/` in the browser while focus is outside any text field.
- Run `notes search <query>` in a terminal.

## Driving it with notes-harness

Preconditions:

- `notes-harness doctor` passes for this run's instance.
- The seeded `Quarterly plan` note has body text `Draft budget`.

- **Toolbar entry.** Run `notes-harness browser click --role button --name "Search"`. A dialog `Search notes` opens with focus in its search box.
- **Keyboard entry.** Close the dialog, focus the page, and run `notes-harness browser press --key "/"`. The same dialog opens and no slash is typed into the page.
- **Title match.** Run `notes-harness browser fill --role searchbox --name "Search notes" --value "quarterly"`. `Search results` lists `Quarterly plan` and not `Grocery list`.
- **Body match.** Run `notes-harness browser fill --role searchbox --name "Search notes" --value "budget"`. `Quarterly plan` stays listed with a body excerpt.
- **Open a result.** Run `notes-harness browser click --role link --name "Quarterly plan"`. The dialog closes and the editor heading reads `Quarterly plan`.
- **Empty state.** Reopen search and run `notes-harness browser fill --role searchbox --name "Search notes" --value "volcano"`. A status `No matching notes` appears once the search finishes.
- **Clear.** Run `notes-harness browser click --role button --name "Clear search"`. The search box is empty and `Recent notes` replaces the results.
- **CLI match.** Run `notes-harness cli -- notes search "quarterly" --format json`. Exit code is `0` and stdout holds one object titled `Quarterly plan`.
- **CLI miss.** Run `notes-harness cli -- notes search "volcano" --format json`. Exit code is `0` and stdout is `[]`.
- **Proof.** With results showing, run `notes-harness browser snapshot --aria --path "$EVIDENCE_DIR/search/results.aria.txt"` and `notes-harness browser screenshot --path "$EVIDENCE_DIR/search/results.png"`. Both show Notes, the query, and `Quarterly plan`.

## Gotchas

- Pressing `/` inside a text field types a slash instead of opening search.
- Results arrive after a short debounce. Wait for the results list or the empty status, never a fixed sleep.
- Archived notes are hidden unless `Include archived` is on.
- The CLI prints human-readable text by default. Use `--format json` for assertions.
- Opening a result changes the page. Reopen search before proving another query.
