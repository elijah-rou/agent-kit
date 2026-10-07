# Create a note

A user saves a titled note from the browser or the CLI, can cancel an unfinished draft, and sees the saved note again from a second view.

## Sub-features

- `create-open` opens an empty editor from each browser entry point.
- `create-save` stores a title and a body.
- `create-cancel` discards an unfinished browser draft.
- `create-cli` creates the same kind of note from a terminal.

## How to get to it (user POV)

- Choose `New note` in the browser toolbar.
- Press `n` in the browser while focus is outside any text field.
- Run `notes create --title <title> --body <body>` in a terminal.

## Driving it with notes-harness

Preconditions:

- `notes-harness doctor` passes for this run's instance.
- No note is titled `Release checklist` or `CLI note`.

- **Open the editor.** Choose `New note`. Run `notes-harness browser click --role button --name "New note"`. A form named `Note editor` appears with focus in the `Title` field.
- **Enter content.** Run `notes-harness browser fill --role textbox --name "Title" --value "Release checklist"` and `notes-harness browser fill --role textbox --name "Body" --value "Tag and publish"`. `Save note` becomes enabled.
- **Save.** Run `notes-harness browser click --role button --name "Save note"`. A status `Note saved` appears and the heading reads `Release checklist`.
- **Confirm it persisted.** Run `notes-harness browser click --role link --name "All notes"`, then `notes-harness browser click --role link --name "Release checklist"`. The editor shows both saved values.
- **Cancel a draft.** Run `notes-harness browser click --role button --name "New note"`, `notes-harness browser fill --role textbox --name "Title" --value "Discard me"`, and `notes-harness browser click --role button --name "Cancel"`. The list returns with no `Discard me` entry.
- **Create from the CLI.** Run `notes-harness cli -- notes create --title "CLI note" --body "Created from terminal" --format json`. Exit code is `0` and stdout holds the new note's ID and title.
- **Proof.** From `All notes`, run `notes-harness browser snapshot --aria --path "$EVIDENCE_DIR/create-note/list.aria.txt"` and `notes-harness browser screenshot --path "$EVIDENCE_DIR/create-note/list.png"`. Both show `Release checklist` and `CLI note`.

## Gotchas

- Pressing `n` while a text field has focus types the letter instead of opening an editor.
- Titles are trimmed on save. Assert the rendered title, not the typed value.
- `Note saved` alone is not proof. Reopen the note from the list.
- Cleanup removes `Release checklist` and `CLI note` but keeps their evidence.
