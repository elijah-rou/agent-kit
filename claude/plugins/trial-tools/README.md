# Trial tools

A local Claude Code Mod with clipboard/Git commands, a throughput display, and structured validation. Tested on 2.1.285 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Enable it through `scripts/claude-link --utilities` from the bootstrap checkout, then restart Claude Code. It registers one model tool for validation. It does not call models, approve permissions, or fetch quota APIs.

| Command | Action |
| --- | --- |
| `/clip text` | Copy literal text. |
| `/clip @path` | Copy a file's text. Relative paths resolve under the session directory. Paths with spaces use the entire text after `@`, without shell quoting. |
| `/copy-all` | Copy user and assistant text from this thread, without tool metadata. |
| `/changes` | Show Git status, staged/unstaged diff stats, untracked files, and five recent commits. |
| `/tps` | Show the last main turn's output tokens per elapsed second. |
| `/validate {"action":"test","command":"…"}` | Run the validation tool directly, without a model request. |

Clipboard commands accept only composer, Remote Control bridge, or explicit CLI/SDK origins. Other plugins, background jobs, peer messages, and unclassified origins are refused before reading files. A remote or headless surface without clipboard support reports failure; there is no shell fallback. Native terminal clipboard support may use OSC 52, whose delivery cannot be acknowledged.

Clipboard content is limited to 1,048,576 JavaScript characters. `/copy-all` refuses a thread at the native 4,096-row limit because its completeness is unknown, and refuses oversized output rather than silently truncating it. It copies visible message text, not a redacted export: do not copy a sensitive conversation unintentionally.

Git queries use argument arrays, a five-second per-process timeout, and bounded output. External diff/text conversion, signature verification, fsmonitor helpers, and optional index refreshes are disabled. `/changes` inspects the whole current workspace, not only this agent's edits, and does not track last-turn filenames.

The TPS band keeps existing above-prompt content and stays out of question dialogs and subagent transcript views. Session-local state survives hot reload and resets with native session state. It ignores child and stale completions; a versioned write prevents an old result from replacing a newer turn. The rate includes reasoning output, tool execution, and network waits; it is not model decoding speed. Aborted turns are labelled interrupted.

## Validation and receipts

`mcp__trial-tools__project_validate` accepts `action` (`test`, `lint`, or `typecheck`), optional `command` and `cwd`, and optional `timeoutMs`. Prefer a known, non-mutating command. Do not use install, fix, format-write, deployment, publication, or arbitrary chore commands. Command text is limited to 8,192 characters and directories to 4,096. Timeout defaults to 120 seconds; integer values from 1 to 300 seconds are accepted, not clamped.

```text
/validate {"action":"test","command":"python3 tests/example_test.py","timeoutMs":30000}
```

The adapter calls native Bash with normal permission and sandbox checks. Denial prevents execution; it does not add allow rules or disable sandboxing. A Python 3.9+ helper runs the selected command, bounds retained output to 30,000 bytes plus a truncation marker, and terminates its owned process group on timeout or interruption. Commands still have local user permissions: this is not a read-only sandbox. Checks must not daemonize. Detached descendants or forced SIGKILL of the helper can bypass graceful cleanup.

Explicit commands use the requested directory, relative to the session directory when needed. Without a command, detection walks at most 32 parent directories within the Git repository and selects npm/pnpm/Yarn/Bun, Cargo, Go, Python, Make, or Just. An unrecognized project returns `unsupported` rather than success. UV detection disables dependency syncing, lockfile updates, and Python downloads.

The tool returns JSON text with outcome, exit code, elapsed time, bounded output, diagnostics, and a versioned receipt. Each completed attempt records its command, directory, timestamps, unique ID, verifier, and before/after workspace fingerprints. Fingerprints hash repository root, HEAD, index entries, and raw tracked/nonignored untracked regular-file bytes and modes. Reading raw bytes avoids Git clean/textconv helpers and line-ending normalization. Limits are 1 MiB per Git response, 1,000 workspace files/20 MiB total content, and 100 untracked files/10 MiB untracked content. Symlinks, submodules, unreadable files, changing files, and over-limit workspaces produce unavailable fingerprints.

`workspaceStable: true` means the two observations matched, not that the workspace was locked. Ignored files, dependencies, and environment are excluded. Changed or unavailable fingerprints appear as explicit gaps; command exit zero alone is not acceptance. Denial, cancellation, or a failed launch can return no receipt. Receipts are not cached, automatically reused, or written into the repository. Child receipts remain worker evidence; the parent owns acceptance. See the [execution and receipt decision](validation-contract.md).

## Development

Load this directory with `claude --plugin-dir PATH`, with the early-access flag enabled on 2.1.285, to generate `.claude-plugin/types/` for your installed version. Those declarations are the API authority and remain ignored. Check types before running tests:

```sh
tsc -p PATH --noEmit
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate --strict PATH
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test PATH
```

Native tests stub clipboard and Git APIs; they do not change the real clipboard, access credentials, or make model requests. Drawing tests validate terminal and desktop trees, not the app's paint. Inspect the band in a fresh interactive session after changing its layout.
