# Trial tools

A local Claude Code Mod with direct commands and a small throughput display. Tested on 2.1.285 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Enable it through `scripts/claude-link --utilities` from the bootstrap checkout, then restart Claude Code. It does not register model tools, call models, approve permissions, or fetch quota APIs.

| Command | Action |
| --- | --- |
| `/clip text` | Copy literal text. |
| `/clip @path` | Copy a file's text. Relative paths resolve under the session directory. Paths with spaces use the entire text after `@`, without shell quoting. |
| `/copy-all` | Copy user and assistant text from this thread, without tool metadata. |
| `/changes` | Show Git status, staged/unstaged diff stats, untracked files, and five recent commits. |
| `/tps` | Show the last main turn's output tokens per elapsed second. |

Clipboard commands accept only composer, Remote Control bridge, or explicit CLI/SDK origins. Other plugins, background jobs, peer messages, and unclassified origins are refused before reading files. A remote or headless surface without clipboard support reports failure; there is no shell fallback. Native terminal clipboard support may use OSC 52, whose delivery cannot be acknowledged.

Clipboard content is limited to 1,048,576 JavaScript characters. `/copy-all` refuses a thread at the native 4,096-row limit because its completeness is unknown, and refuses oversized output rather than silently truncating it. It copies visible message text, not a redacted export: do not copy a sensitive conversation unintentionally.

Git queries use argument arrays, a five-second per-process timeout, and bounded output. External diff/text conversion, signature verification, fsmonitor helpers, and optional index refreshes are disabled. `/changes` inspects the whole current workspace, not only this agent's edits, and does not track last-turn filenames.

The TPS band keeps existing above-prompt content and stays out of question dialogs and subagent transcript views. Session-local state survives hot reload and resets with native session state. It ignores child and stale completions; a versioned write prevents an old result from replacing a newer turn. The rate includes reasoning output, tool execution, and network waits; it is not model decoding speed. Aborted turns are labelled interrupted.

## Development

Load this directory with `claude --plugin-dir PATH`, with the early-access flag enabled on 2.1.285, to generate `.claude-plugin/types/` for your installed version. Those declarations are the API authority and remain ignored. Check types before running tests:

```sh
tsc -p PATH --noEmit
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate --strict PATH
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test PATH
```

Native tests stub clipboard and Git APIs; they do not change the real clipboard, access credentials, or make model requests. Drawing tests validate terminal and desktop trees, not the app's paint. Inspect the band in a fresh interactive session after changing its layout.
