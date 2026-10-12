# Skill catalog

agent-kit's skills, instructions, and subagent roles reach three runtimes through different lists: Claude Code gets the entries in `claude/skills.txt` and the roles in `claude/agents/`, Codex gets the names in `codex/skills.txt`, and Pi loads every skill under the package's `pi.skills` directories. A repository's own skills under `.agents/skills/` reach Pi and Codex directly and reach Claude Code through a link in `.claude/skills/`. Every exported skill must load: valid frontmatter named after its directory, references that exist, and runtime-neutral text in Claude's export.

## Sub-features

- `catalog-check` runs the repository's own skill checker over every skill, export list, and role.
- `catalog-claude` resolves each `claude/skills.txt` entry to a loadable skill.
- `catalog-codex` resolves each `codex/skills.txt` name to a loadable skill.
- `catalog-pi` lists every skill the Pi package loads.
- `catalog-repo` resolves each repository skill and its `.claude/skills/` link.
- `catalog-roles` lists each Claude subagent role with its model, effort, and tools, and checks it binds a Claude model.

## How to get to it (user POV)

- Bootstrap links the Claude export and roles into the Claude configuration directory; a Claude Code session then offers the skills and the subagent roles.
- Bootstrap links the Codex export; Codex offers those skills.
- Pi loads the agent-kit package and offers every skill under `skills/`.
- Opening a session in a repository offers its `.agents/skills/` skills (Claude Code through `.claude/skills/`).

## Driving it with verify-kit

Preconditions:

- Drive target: `scripts/verify-kit drive RUN_ID skill-catalog`.
- Doctor passed. No network or credentials are needed.

- **Checker.** `bun scripts/check-skills.ts` exits 0.
- **Exports.** Every entry of each list resolves to a `SKILL.md` whose `name` equals its directory. `exports.tsv` lists runtime, skill, path, whether the model may invoke it, and the description's length.
- **Repository skills.** Every `.agents/skills/<name>/SKILL.md` is readable through `.claude/skills/<name>/SKILL.md` with identical content.
- **Roles.** Every `claude/agents/*.md` has a name and a description and binds a `claude-` model. `roles.tsv` lists role, model, effort, tools, and disallowed tools.
- **Proof.** Evidence: `skill-catalog/01-check-skills.txt`, `exports.tsv`, and `roles.tsv`. For a change to skills or instructions, diff the parent's and head's `exports.tsv` and `roles.tsv`.

## Gotchas

- This proves the text loads and resolves, not how an agent behaves under it; a verdict for an instruction change says so.
- A skill marked `disable-model-invocation: true` is listed as `user-only`: only a person can start it.
- The checker reads the working tree, including uncommitted edits; doctor's tree check is what ties a run to a revision.
