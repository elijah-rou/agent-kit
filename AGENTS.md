# agent-kit

The instructions, skills, subagent roles, hooks, and the `agentic` CLI that Claude Code and Pi load for every
repository the user works in. A change here changes agent behavior everywhere once an install moves to it, so
treat instruction text as code: it gets the same validation, verification, and review.

This file guides work on the repository itself. The shipped instructions are `claude/CLAUDE.md` and
`pi/AGENTS.md`; Claude Code also loads `claude/CLAUDE.md` when it reads files under `claude/`, as text being
edited, not as guidance for this repository.

## Standalone

agent-kit has no reverse relationship with anything that installs, configures, or consumes it. Its code, skills,
instructions, and docs name, depend on, or describe no installer, dotfiles repository, or other consumer. The
exceptions are the agent runtimes (Claude Code, Pi) and the orchestrator (T3 Code), which the kit needs in
order to function. Credits to upstream sources it adapts, and the tools and services it calls, are not
consumers. `README.md` and `claude/README.md` state what any install must provide (links, `settings.json`
entries, the watchdog timer); how a particular installer meets that belongs in the installer's repository. A
change that needs installs to act differently changes that contract here and leaves each installer's change to
its own repository.

## Edit map

- `claude/CLAUDE.md` and `pi/AGENTS.md`: the global working rules, one copy per runtime. Most rules appear in
  both, word for word or nearly; they differ in delegation mechanics (Claude roles versus Pi subagents), and
  Pi's copy keeps its own communication style and a few rules Claude's lacks. When you change a rule that both
  copies hold, change both. `scripts/check-skills.ts` requires `claude/CLAUDE.md` to stay runtime-neutral, to
  name only skills exported to Claude, and to have a role line that matches `claude/agents/`.
- `claude/agents/*.md`: the subagent roles, the only files that bind a model to a role. `scripts/check-skills.ts`
  refuses a model ID in `claude/CLAUDE.md`, `skills/`, or `claude/skills/`.
- `skills/`: the shared library. Pi loads all of it; Claude loads the entries in `claude/skills.txt`, which must
  stay runtime-neutral, and Claude-specific adaptations live in `claude/skills/`. A new skill gets a line in
  `claude/skills.txt` when Claude should have it and a line in `skills/README.md` saying where it came from.
  How one skill may refer to another is set in `skills/README.md` (Skill boundaries).
- Adapted skills keep their upstream license file, a row in `provenance.toml` or the table in
  `skills/README.md`, and a `skills/RESYNC.md` entry for each resync. `agentic upstream-drift` reads those rows.
- `agentic/`: the CLI (`agentic/bin/agentic`) and its tools under `agentic/tools/`. `agentic/vendor/` holds
  copies of pstack's `orch` and `watch-pr`; each `PROVENANCE` keeps its `key: value` lines first and lists every
  local change.
- `pi/`: Pi extensions and their tests, prompts, themes, and `WORKTREE_STREAMS.md`.
- `docs/adr/`: decisions at one-way doors. `docs/design/` and `docs/analysis/` are working documents, and the
  dated analyses are historical. `docs/guide/` is the user guide: update it when how the user prompts an
  agent, or where the agent stops for the user, changes.
- `.agents/skills/verify-agent-kit/`: this repository's verification skill. `.claude/skills/verify-agent-kit` is
  a symlink to it.

## Validate

```sh
bun install --frozen-lockfile
scripts/validate   # needs Bun, ripgrep, zsh, and Python 3
```

`scripts/validate` is the one validate command: whitespace, the public-safety scan of the index and worktree,
`scripts/check-skills.ts`, and `bun test` over `pi/tests`, `agentic`, `skills`, and `claude/tests` (whose runtime
test needs a `claude` CLI on `PATH`). CI runs it on Ubuntu and macOS. The repository is public: the scan refuses
private literals, and nothing machine-specific (home paths, usernames, hostnames, email addresses) belongs in a
tracked file or a commit message.

## Verify

Prove a change with `verify-agent-kit` (its `SKILL.md`). Run the kit from a clean trunk checkout and point
`--checkout` at a detached worktree of the head, so a pull request never supplies its own verifier. The path
table in that `SKILL.md` names the drives each changed path needs. Instruction text passes on a `skill-catalog`
drive plus a read against the pull request's intent, and its evidence says agent behavior was not observed.

The policy paths, which `agentic verify --help` prints, set the verification policy. A change to one never
passes on a verifier's verdict; it lands only on a countersign, the user's approval in their own words of the
exact patch.

## Git and pull requests

- Work on an `agent/<topic>` branch in its own worktree, off `origin/main` for independent work or off its
  parent's branch in a stack (`skills/babysit-and-ship/references/pr-body.md`). Never edit a checkout an
  install runs from.
- Commit subjects are one imperative sentence naming the outcome ("Remove the design-control-loop skill").
  Pull requests are squash-merged, so the title becomes the commit on `main`.
- Write the pull request body as `skills/babysit-and-ship/references/pr-body.md` describes, including the
  validate command, its outcome, and the short SHA it ran on.

## Review rules

`pr-review` applies these to every pull request here, citing each by its id:

- `standalone`: a tracked file that names, depends on, or describes something that installs, configures, or
  consumes agent-kit, other than the agent runtimes and T3 Code, is a finding.
- `runtime-copies`: a rule that `claude/CLAUDE.md` and `pi/AGENTS.md` both hold, changed in only one of them, is
  a finding unless the change is runtime mechanics.
- `stale-description`: a change to behavior that `README.md`, an ADR, `docs/guide/`, or a verify feature file
  describes updates that description in the same pull request; a description the change makes false is a
  finding.

`correct` adds proven rules to `rules.toml` at the repository root; the reviewer applies its `review` rows too.
