# Claude Code surface

agent-kit adds two things a Claude Code user sees directly. The status line renders the five-hour and seven-day quota windows Claude supplies on stdin, with a gauge and a reset countdown, and falls back to `claude limits: n/a` for missing or invalid data. It also records a valid seven-day window under `$XDG_STATE_HOME/agentic/quota/`, keeping the highest usage seen in the week, and `agentic quota pace` reads it back as under, over, exhausted, or unknown pace. The trial-tools Mod adds `/clip`, `/copy-all`, `/changes`, `/tps`, and `/validate`, and its manifest and native tests run through the real `claude` CLI without any model request.

## Sub-features

- `statusline-quota` renders both windows with gauges and countdowns, and records the seven-day window.
- `quota-pace` reads that record back with `agentic quota pace --json`.
- `statusline-missing` shows `claude limits: n/a` without rate limits.
- `statusline-invalid` shows `claude limits: n/a` for input that is not JSON.
- `mod-validate` passes `claude plugin validate --strict`.
- `mod-test` runs the Mod's native tests through `claude plugin test` with no failures and no change to the checkout.

## How to get to it (user POV)

- Claude Code runs the status line command from `settings.json` on every render and pipes its session JSON to it.
- With the Mod enabled, type `/clip`, `/copy-all`, `/changes`, `/tps`, or `/validate` in a Claude Code session.
- A developer loads the Mod with `claude --plugin-dir claude/mods/trial-tools`.

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID claude-surface`.
- Doctor passed. For the Mod steps, doctor reports the `claude` CLI; without it the drive checks the status line and ends with `SKIP`.

- **Quota.** `bun claude/statusline.ts` with `five_hour` at 42.4% resetting in 90 minutes and `seven_day` at 7% resetting in about 55 hours prints `claude 5h ▄ 42% ↻1h30m · 7d ▁ 7% ↻2d7h` (the minutes may read 29). Every status line step runs with `XDG_STATE_HOME` set to a directory in the run, which then holds `agentic/quota/claude-seven-day/<resetsAt>_7.json`; the fixture's window never reaches the real state directory.
- **Quota pace.** `bun agentic/bin/agentic quota pace --json` with the same `XDG_STATE_HOME` exits 0 and prints `state` `under` with `usedPercent` 7: the fixture's week resets in 200,000 of its 604,800 seconds, so about 67% of it has elapsed.
- **Missing limits.** Input `{}` prints `claude limits: n/a` and exits 0.
- **Invalid input.** Input `not json` prints `claude limits: n/a` and exits 0.
- **Manifest.** `claude plugin validate --strict claude/mods/trial-tools` with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` exits 0 and prints `Validation passed`.
- **Native tests.** `claude plugin test claude/mods/trial-tools` with the same flag exits 0 with at least one pass and `0 fail`. `git status --porcelain=v1 -uall` is identical before and after.
- **Proof.** Evidence: `claude-surface/NN-*.txt` with each command's output.

## Gotchas

- The strict validator also prints advice about a marketplace install line; it is not a failure.
- The Mod's native tests stub the clipboard and Git; the slash commands' real clipboard and screen output need an interactive session, which this skill does not drive.
- The countdown depends on the second the status line starts; the drive accepts either minute.
