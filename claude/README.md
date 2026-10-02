# Claude Code trial profile

This profile ports the working rules and selected skills without changing other agent setups. The instructions and exported skill content do not depend on a particular agent runtime. Loading them uses Claude Code's native paths.

## Link the profile

Requires Python 3.9 or newer. Run from this checkout:

```sh
./scripts/claude-link
```

Without options, the offline linker creates `~/.claude/CLAUDE.md` and individual links under `~/.claude/skills/`. It preserves settings, authentication, hooks, plugins, custom skills, and all repository files. `--home ABSOLUTE_DIRECTORY` selects a different Claude configuration directory for a disposable test.

Repeated runs leave existing correct links unchanged. An interrupted run resumes from the links already installed. Concurrent runs fail on `.bootstrap-link.lock`; confirm the previous process has stopped before removing a stale lock. Custom files, foreign links, and linked configuration roots cause an error before any instruction or skill link changes. Resolve those conflicts explicitly; the linker does not overwrite or adopt them.

The links point to this checkout. Keep it until you explicitly relink from another reviewed source. This profile is opt-in; existing installation and configuration commands do not install it.

## Sources and adaptations

`CLAUDE.md` preserves coding, verification, authorization, workspace, delegation, and communication rules. Long runs keep progress in an existing task/plan file, continue through routine decisions, and report blockers and evidence gaps first. It does not change model, effort, paid usage, permissions, or automatic memory settings.

`skills.txt` exports fifteen skills, including `blast-radius`, `make-operations-idempotent`, `separate-before-serializing-shared-state`, and `show-me`. Already-neutral skills reuse their source directories. Research, instruction-writing, and visualization use local adapters to remove provider routing, rendering, and runtime-specific tool assumptions. Source paths do not depend on another running agent. The base linker installs no custom subagents, extension tools, or orchestration packages.

On supported versions, Claude Code loads repository `AGENTS.md` when no project-path `CLAUDE.md` overrides it. User-level `~/.claude/CLAUDE.md` does not suppress that fallback. Do not add copied repository instructions merely to enable it. See the current [instruction-loading reference](https://code.claude.com/docs/en/memory#agents-md) and [skill reference](https://code.claude.com/docs/en/skills).

Restart Claude Code after linking. In a fresh session, use `/memory` to check the instruction paths and `/skills` to inspect the exported skills. These consumer checks do not require a coding task.

## Optional quota footer and utilities

```sh
./scripts/claude-link --utilities
```

This links a native quota status line and the [trial-tools Mod](plugins/trial-tools/README.md). It changes only `statusLine` and `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` in user settings. Model, effort, permissions, hooks, authentication, and other environment values stay unchanged. The Mod lives under `~/.claude/skills/trial-tools/`, where the tested runtime discovers its plugin manifest.

The linker refuses custom status lines and an active `disableAllHooks` policy. It backs up the original settings privately under `~/.claude/backups/`, then replaces the settings atomically. Its lock coordinates other linkers. If it detects an outside settings edit before replacement, it stops; rerun after that writer finishes.

The status line reads Claude's supplied five-hour/seven-day quotas and reset times, with the existing single-glyph gauges. It never reads credentials or calls provider endpoints. Missing or invalid usage and expired windows show `limits: n/a`, not zero usage. Valid usage without a usable reset time shows the gauge and percentage without a countdown. Claude supplies subscription quotas only after the first response on Pro/Max. A 60-second refresh keeps countdowns current while idle.

`trial-tools` adds `/clip text`, `/clip @path`, `/copy-all`, `/changes`, and `/tps`. Clipboard commands require a direct user/CLI origin; they are not model tools. TPS appears above the prompt and measures output tokens per whole-turn wall-clock second, including tools and network waits, not decoding speed. No background model calls or permission-approval hooks run.

Tested on Claude Code 2.1.285 with early-access Mods explicitly enabled. Mods are on by default from 2.1.287; their API may change. Restart Claude Code after installation, inspect `/plugin`, and run `/changes` or `/tps` without starting a model task. Clipboard copying needs an interactive terminal or desktop surface.

## Check changes

```sh
python3 tests/claude_link_test.py
python3 tests/claude_profile_test.py
python3 tests/claude_statusline_test.py
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate --strict claude/plugins/trial-tools
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test claude/plugins/trial-tools
python3 tests/claude_tools_runtime_test.py
```

For typechecking, first load the plugin from this checkout with early-access Mods enabled to generate the installed runtime's declarations. Run `tsc -p claude/plugins/trial-tools --noEmit` before its tests. Do not commit `.claude-plugin/types/`: those declarations belong to the installed Claude version, not this profile.

Linker checks cover repeat runs, partial repair, conflicts, locks, limits, settings preservation, and private backups. Profile checks parse skill frontmatter and resolve local references. Footer checks cover quotas, countdowns, absent/invalid/stale data, and bounded stdin. Native Mod tests cover clipboard failures and limits, read-only Git commands, and TPS state and drawings. The runtime check replays the Mod's actual Git arguments against a signed-commit fixture with a marker-writing verifier. It also checks index preservation and links a disposable profile, then runs native `/changes` without `--plugin-dir` and verifies zero model usage. Repository-wide validation runs these checks when the CLI supports them.
