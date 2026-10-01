# Claude Code trial profile

This profile ports the working rules and selected skills without changing other agent setups. The instructions and exported skill content do not depend on a particular agent runtime. Loading them uses Claude Code's native paths.

## Link the profile

Requires Python 3.9 or newer. Run from this checkout:

```sh
./scripts/claude-link
```

The offline linker creates `~/.claude/CLAUDE.md` and individual links under `~/.claude/skills/`. It preserves settings, authentication, hooks, plugins, custom skills, and all repository files. `--home ABSOLUTE_DIRECTORY` selects a different Claude configuration directory for a disposable test.

Repeated runs leave existing correct links unchanged. An interrupted run resumes from the links already installed. Concurrent runs fail on `.bootstrap-link.lock`; confirm the previous process has stopped before removing a stale lock. Custom files, foreign links, and linked configuration roots cause an error before any instruction or skill link changes. Resolve those conflicts explicitly; the linker does not overwrite or adopt them.

The links point to this checkout. Keep it until you explicitly relink from another reviewed source. This profile is opt-in; existing installation and configuration commands do not install it.

## Sources and adaptations

`CLAUDE.md` preserves coding, verification, authorization, workspace, delegation, and communication rules. Long runs keep progress in an existing task/plan file, continue through routine decisions, and report blockers and evidence gaps first. It does not change model, effort, paid usage, permissions, or automatic memory settings.

`skills.txt` is the reviewed export manifest. Already-neutral skills reuse their source directories; research and instruction-writing have local adapters that remove provider routing and other runtimes' tool or metadata assumptions. Their source paths are an implementation detail, not a dependency on another running agent. No custom subagents, extension tools, or orchestration packages are installed.

On supported versions, Claude Code loads repository `AGENTS.md` when no project-path `CLAUDE.md` overrides it. User-level `~/.claude/CLAUDE.md` does not suppress that fallback. Do not add copied repository instructions merely to enable it. See the current [instruction-loading reference](https://code.claude.com/docs/en/memory#agents-md) and [skill reference](https://code.claude.com/docs/en/skills).

Restart Claude Code after linking. In a fresh session, use `/memory` to check the instruction paths and `/skills` to inspect the exported skills. These consumer checks do not require a coding task.

## Check changes

```sh
python3 tests/claude_link_test.py
python3 tests/claude_profile_test.py
```

The linker tests exercise installation, repeat runs, partial repair, conflicts, locks, limits, invalid inputs, and preservation of settings. Profile checks parse the exported frontmatter and resolve local references. Repository-wide validation also runs these checks.
