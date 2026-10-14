# Model roles: which model each kind of child task gets

- **Status:** the initial version (Claude only, below) is built on 2026-10-12. The rest of this document is the full design, kept for when a second provider returns. Codex support was removed on 2026-10-14 (PR #39), so wherever the full design names Codex as the second harness, that part is superseded and kept only as a record.
- **Reader:** the user, then whoever builds it.
- **Method:** `design-checkpoint`. Candidates came from GPT-6.1 Sol (B) and Claude Fable 5.1 (C). Candidate A (Claude Opus 5.5) hit a session limit and left a partial sketch, which was read. The rubric is at the end.

## Initial version: Claude only

The user is retiring the Codex subscription and asked for an initial version built for Claude Code alone, using only Haiku 5.5 and Opus 5.5 (no Fable or Sonnet), to refine later. With one provider, every role is a native Claude Code agent, so most of the full design is not needed yet.

| Role (agent name) | Use for | Model | Effort | Tools |
| --- | --- | --- | --- | --- |
| `Explore` | read-only lookups; replaces Claude Code's built-in `Explore`, which otherwise runs on the main model | `claude-haiku-5-5` | `medium` | no `Agent`, `Edit`, `Write`, `NotebookEdit` |
| `quick` | bulk or bounded work that writes | `claude-haiku-5-5` | `high` | no `Agent` |
| `build` | implementation, diagnosis, and fresh verifiers that run the product and record a verdict | `claude-opus-5-5` | `high` | no `Agent` |
| `review` | read-only review by a child that did not write the change: designs, run transcripts | `claude-opus-5-5` | `xhigh` | only `Read`, `Grep`, `Glob` |
| `pr-review` | adversarial pull-request review; reads `git-workflow`'s review procedure and the repository's review rules itself (added 2026-10-13) | `claude-opus-5-5` | `xhigh` | only `Read`, `Grep`, `Glob` |
| `autopilot-owner` | the one child that may publish: an autopilot-full owner carrying its own pull request to merge | `claude-opus-5-5` | `high` | no `Agent` |

What is built:

- `claude/agents/{explore,quick,build,review,pr-review,autopilot-owner}.md`, in Claude Code's own agent format, hold the opinion (model and effort in the frontmatter) and each role's charter (the body). Bootstrap links them into `~/.claude/agents/` the same way it links `CLAUDE.md` (a bootstrap PR, live once bootstrap's agent-kit pin advances), so there is no renderer.
- `claude/CLAUDE.md` names the six roles and tells the parent to launch by role, pass no model or effort, and not delegate what it can finish in a handful of tool calls. The rules no longer ask for a reviewer on an alternate model. `review` is a real read-only boundary (an allowlist of read tools), so reflect's transcript lenses, the Attention review and the design-checkpoint judge use it, and the pull-request reviewer uses `pr-review`, the same boundary with the review procedure built into its charter; verifiers that must run the product and record a verdict use `build`. The reviewer states its own model on its first line, because a parent that launches by role no longer chooses it.
- `scripts/check-skills.ts` fails when a role file names a model other than Haiku 5.5 or Opus 5.5, sets an unknown effort, or allows `Agent`; when the roles named in `claude/CLAUDE.md` and the role files disagree; and when `claude/CLAUDE.md` or any skill names a model ID.

What is deferred, with the reason:

- **The overlay, the renderer, the role table, `SessionStart` hooks and T3 targets.** They exist to cross providers and harnesses. With one provider, the agent files are the whole mechanism.
- **Pi.** `pi/AGENTS.md` is unchanged, including its alternate-model reviewer wording. `codex/AGENTS.md` and its model table were removed with Codex support on 2026-10-14.
- **Open questions 2 and 6** (cross-harness `quick` and `explore`, and usage-limit fallback) do not arise with one provider. Question 4 took its default. Question 1 took its default except `quick`, which the user moved to `high` because it writes files. Question 3 kept design-checkpoint's candidate-diversity preference until the user reopened it on 2026-10-13 and removed it: subagents are Claude-only, after a candidate sent to another provider stalled a trial.

Verified on 2026-10-12 with Claude Code 2.1.296 in a scratch project: the four files, copied and also as symlinks, appear in the session's agent list, with `Explore` replacing the built-in. A headless run launched `Explore` on `claude-haiku-5-5` and `review` on `claude-opus-5-5`. Whether `effort` took effect is not visible in the output.

## The door

Two things here become contracts shared between agent-kit and bootstrap. The first is the role names (`explore`, `quick`, `build`, `review`): skills and instructions name them, native agent types and T3 delegations carry them, and Jev routing records will store them. The second is the per-machine overlay format, `~/.config/bootstrap/roles.json`, which each machine's private dotfiles persist. Everything else is reversible: which model and effort a role gets, the renderer, and the wording.

## Problem

agent-kit needs one opinion on which model and effort each kind of child task gets. That opinion has to reach a Claude Code or Codex parent on any machine as a launch the parent can make without looking anything up. Each machine says what it can reach in bootstrap, and nothing guesses.

Today the opinion is scattered, and the copies disagree:

- `codex/AGENTS.md` has a six-row table that is out of date: it names `gpt-5.6-sol` for the second opinion, and `gpt-6.1-sol` exists.
- `claude/CLAUDE.md` has a rule ("match model and effort to each task") but no table.
- `pi/AGENTS.md` defers to role profiles that live in bootstrap's `pi/agents/`. Four of those route through `opencode/grok-4.6`, against the no-OpenCode decision.
- Bootstrap's `codex/config.toml` sets the default for untyped spawns to `gpt-6-astra` at `low`.
- Ten places in instructions and skills require the reviewer to run on a different model family. The user no longer requires that.

Already decided by the user:

- The opinion lives in agent-kit. What each machine can reach lives in bootstrap.
- The bindings are: bulk or quick work on `claude-haiku-5-5`, independent or adversarial review on `gpt-6.1-sol`, and implementation (with the review done while building) on `claude-opus-5-5`.
- A reviewer is defined by independence, not by model family. It did not write the change, starts from a brief, changes nothing, and reports only blocking findings.
- No OpenCode routes.
- An unreachable model is reported, never silently replaced.

Two more constraints are already in force. The parent already understands the task, so there is no classifier call (`codex/AGENTS.md:39`). Pi is not in daily use: T3 Code drives Claude Code and Codex. Pi is deferred, as below.

## Usage (caller's view)

**From Claude Code.** The Agent tool lists `quick` and `build` as agent types, and the built-in `Explore` now runs on `claude-haiku-5-5` because the `explore` role overrides it. The parent launches by name and passes no model:

```
Agent(subagent_type: "build", prompt: <brief>)
```

A table of roles is already in context, added by a `SessionStart` hook (described below). Its `review` row says the role does not run natively here and gives the T3 target, so a review from a Claude parent inside T3 is one call:

```
delegate_task(target: {providerInstanceId: "codex", model: "gpt-6.1-sol", options: {reasoningEffort: "xhigh"}},
              task: <review charter from the table> + <brief>)
```

**From Codex.** `review` is a native agent type (`~/.codex/agents/review.toml`), spawned by name. `build`, `quick` and `explore` are rows in the same table, which a Codex `SessionStart` hook puts in context, and each row has its T3 target.

**Outside T3.** A Claude Code parent in a plain terminal has no route to `gpt-6.1-sol`. It reports `review` as unavailable and launches nothing in its place. A Codex parent is in the same position for `explore`, `quick` and `build` (see open question 2).

**Changing the opinion.** Edit one line in one file, open a PR, advance bootstrap's agent-kit pin, then run `install.sh link`:

```
# agent-kit/roles/review.md
model: gpt-6.1-sol      ->  model: gpt-6.2-sol
```

**A machine without an Anthropic subscription.** Its private dotfiles carry this file:

```json
{ "unavailable": ["anthropic"],
  "roles": {
    "build": { "model": "gpt-6.1-sol", "effort": "high", "reason": "no Anthropic subscription on this machine" },
    "quick": { "model": "gpt-6-luna", "effort": "medium", "reason": "no Anthropic subscription on this machine" } } }
```

The rendered table ends with: `Machine overrides: build gpt-6.1-sol high (agent-kit default claude-opus-5-5 high), quick gpt-6-luna medium (agent-kit default claude-haiku-5-5 medium): no Anthropic subscription on this machine.` Deleting an entry returns that role to the agent-kit default. If an overlay declares `anthropic` unavailable but does not rebind every role on it, install refuses, names the role and the file, and writes nothing.

**Inspecting.** `agentic roles show` prints this machine's table. `agentic roles check` compares a fresh render with what is installed and names every file that drifted.

## Shape

### Roles

| Role | Use for | Model (decided) | Effort (proposed) | Read-only | T3 role |
| --- | --- | --- | --- | --- | --- |
| `explore` | read-only lookups, codebase search, scouting | `claude-haiku-5-5` | `medium` | yes | `research` |
| `quick` | bulk or mechanical edits, bounded tasks that write, summaries | `claude-haiku-5-5` | `medium` | no | `general` |
| `build` | implementation, diagnosis, and the review done while building | `claude-opus-5-5` | `high` | no | `implementation` |
| `review` | independent review or verification of work the child did not write | `gpt-6.1-sol` | `xhigh` | yes | `review` |

Existing call sites map onto these four roles:

- `review`: show-me-your-work's attention reviewer, design-checkpoint's judge, and reflect's lenses. The pull-request reviewer became its own role, `pr-review`, in the initial version above.
- `build`: design-checkpoint's candidates, reflect's synthesizer, the ship and autopilot verifiers (they run the product and record a verdict), and all implementation.
- `explore`: scouting and bounded lookups, including the ones Claude Code delegates to `Explore` on its own.
- `quick`: bulk or mechanical edits and other bounded work that writes.

Focused research has no decided model, so it runs as `build`. A `research` role is the first likely split, and a `verify` role is the second: a reviewer that drives the real product and writes evidence under a sandbox.

### Source of truth

`agent-kit/roles/<role>.md` holds one role per file. The frontmatter is the opinion. The body is the role's charter: what the child is and what it may not do.

```markdown
---
name: review
use: Independent review or verification of work the child did not write
model: gpt-6.1-sol
effort: xhigh
readOnly: true
t3Role: review
---

You are an independent reviewer. You did not write the change, you start from this brief rather than the author's transcript, and you report only findings that would block acceptance: each with its location, why it is wrong, and how to show it fails. "No blocking findings" is a valid result. Change nothing in the repository; the only writes allowed are evidence files and a verdict the brief asks for. Do not publish, push, comment, or launch children.
```

A role may also set `nativeName` for a harness, which makes its rendered agent replace that harness's built-in agent of the same name. The only use today is `explore`, which sets `nativeName: {claude: Explore}`. The Claude Code docs describe exactly this override: a user agent named `Explore` with `model: haiku`. Codex's built-in `explorer` is left alone, because Codex cannot run Haiku.

`agent-kit/roles/catalog.json` lists the models a role may name. For each model it gives the provider and the effort levels that model accepts. For each provider it says how each harness spells a launch: native, a T3 target with an option name, or `null` for no route. Pi's Anthropic entry stays `null` until pi-claude-bridge is adopted.

### Overlay

`~/.config/bootstrap/roles.json` sits next to the existing `claude-settings.json` and `pi-settings.json` overlays. It accepts these keys:

- `unavailable`: a list of providers.
- `roles.<name>`: `{model, effort, reason}`, all three required.
- `models`: a catalog entry this machine knows about and agent-kit does not.

Anything else fails install with a message that names the fix: an unknown key, role or model; an effort the model does not accept; a missing `reason`; `null`, `auto` or `inherit-parent`; or any `opencode/` string. If the file is absent, every role takes the agent-kit default.

The overlay never chooses for itself. `unavailable` exists to turn one situation into an install-time refusal rather than a surprise at launch: a role arrives upstream bound to a provider this machine cannot run.

### Types and signatures

```ts
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Provider = "anthropic" | "openai";
type Harness = "claude" | "codex";              // "pi" when Pi is adopted
type RoleName = string & { readonly brand: "RoleName" };  // /^[a-z]+$/, minted only by loadRoles

interface Binding { model: string; effort: Effort }
interface Role { name: RoleName; use: string; charter: string; binding: Binding; readOnly: boolean; t3Role: string;
               nativeName: Partial<Record<Harness, string>> }   // e.g. explore -> {claude: "Explore"}
interface Override { binding: Binding; reason: string }
interface Overlay { unavailable: ReadonlySet<Provider>; roles: ReadonlyMap<RoleName, Override>; source: string | null }

// One row per role, sorted by name. Every rendered file derives from this.
interface Resolved {
  role: Role;
  binding: Binding;                      // overlay replacement or agent-kit default
  provider: Provider;
  override: { reason: string; replaced: Binding } | null;
}

type Launch =
  | { via: "native"; agent: RoleName }
  | { via: "t3"; target: { providerInstanceId: "claudeAgent" | "codex"; model: string; options: Record<string, string> } }
  | { via: "none"; missing: string };    // printed in the table; never replaced

function loadRoles(files: Map<string, string>): Role[];                        // throws, naming file and field
function loadCatalog(text: string): Catalog;
function parseOverlay(text: string | null, roles: Role[], catalog: Catalog): Overlay;  // throws, naming the fix
function resolve(roles: Role[], catalog: Catalog, overlay: Overlay): Resolved[];      // throws; never substitutes
function launchFor(row: Resolved, catalog: Catalog, harness: Harness): Launch[];       // native first, then t3; empty means none
function render(rows: Resolved[], catalog: Catalog, harness: Harness): Map<string, string>;  // pure, byte-stable
function drift(expected: Map<string, string>, dir: string): Drift[];           // missing | differs | foreign
```

The CLI is `agentic roles show|render|check`, registered in `agentic/bin/agentic`. It has no dependencies beyond Bun.

### Rendered files

`install.sh` runs `agentic roles render --harness H --overlay FILE --out DIR` for each harness:

| File | Claude Code (`~/.claude`) | Codex (`~/.codex`) |
| --- | --- | --- |
| native agent, one per role whose provider runs in this harness | `agents/<role>.md`: `model: <full id>`, `effort:`, `disallowedTools: Agent`, plus `Edit, Write, NotebookEdit` when read-only, charter as body | `agents/<role>.toml`: `name`, `description`, `model`, `model_reasoning_effort`, charter as `developer_instructions`; no `sandbox_mode` (see tradeoffs) |
| the table | `roles.md` | `roles.md` |
| session-start payload | (none; the hook prints `roles.md`) | `roles-session-start.json`: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<roles.md>}}` |
| machine-readable | `roles.json` (`Resolved[]` plus launches) | same |

Each native agent's description is the role's short `use` line and nothing else. Claude Code picks a subagent by its description, and all descriptions share one context budget, so model and effort stay in the frontmatter, `/agents` and the role table. Every Claude role disallows `Agent`, because Claude Code subagents can otherwise nest three levels deep and agent-kit's children do not launch children.

The table for this machine with no overlay, as Claude Code sees it:

```markdown
# Roles on this machine

Rendered from agent-kit roles/ and ~/.config/bootstrap/roles.json; do not edit.

| Role | Use for | Native here | T3 delegate_task target |
| --- | --- | --- | --- |
| quick | bounded lookups, scouting, bulk or mechanical edits, summaries | agent `quick` (claude-haiku-5-5, medium) | {"providerInstanceId":"claudeAgent","model":"claude-haiku-5-5","options":{"effort":"medium"}} |
| build | implementation, diagnosis, the review done while building | agent `build` (claude-opus-5-5, high) | {"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":{"effort":"high"}} |
| review | independent review or verification of work the child did not write | none | {"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"xhigh"}} |

Charters for T3 launches (native agents already carry theirs):
- review: You are an independent reviewer. ...

Machine overrides: none.
```

### How the table reaches context

Both harnesses load it with a `SessionStart` hook, and bootstrap installs the hooks.

- **Claude Code.** The hook in bootstrap's `claude/settings.json` is `cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/roles.md" 2>/dev/null || true`. Claude Code adds plain-text stdout from `SessionStart` hooks to context, and the event fires on startup, resume, clear and compact, so the table survives compaction. Source: code.claude.com/docs/en/hooks.
- **Codex.** The hook goes in bootstrap's `codex/hooks.json`, next to the Jev hook that #19 adds: `cat "${CODEX_HOME:-$HOME/.codex}/roles-session-start.json"`. Codex 0.162.1 defines `SessionStart` with `hookSpecificOutput.additionalContext`. This comes from the binary's schema and has not been run end to end. Like the Jev hook, it needs the user's one-time `/hooks` approval.

`CLAUDE.md` and `AGENTS.md` stay symlinks into agent-kit. Development through `BOOTSTRAP_AGENT_KIT` therefore keeps working, and no instruction file is generated.

### Instruction prose

One paragraph replaces the Codex table at `codex/AGENTS.md:37-48` and the model sentence at `claude/CLAUDE.md:36`:

> Launch children by role, never by picking a model: `explore` for read-only lookups and `quick` for bulk or bounded work that writes, when you could not finish either in a handful of tool calls yourself; `build` for implementation and the review done while building, `review` for independent review (a child that did not write the change, starts from a brief, changes nothing, and reports only blocking findings). The role table in context binds each role to a model and effort on this machine and says whether it is a native agent here or a T3 target. Launch natively when you can, otherwise through the T3 target with the role's charter at the top of the brief, and pass no model or effort of your own. If a role has neither, report it as unavailable with the missing route; do not launch another role or model in its place, and do not relaunch elsewhere after a launch was accepted. Every review record names the model that ran.

The paragraph names no harness, so `check-skills.ts`'s runtime-neutral check still passes for `claude/CLAUDE.md`.

The skills stop saying "different model family" and name the role instead:

- `git-workflow/references/pr-review.md`, steps 4 and 6.
- `babysit-and-ship/references/shipping.md` and `autopilot-full.md`.
- `background-run`: `SKILL.md` and `references/coordination.md`.
- `show-me-your-work`: its "Cross-model Attention" section becomes an independent-review section.
- `design-checkpoint`, steps 3 and 4.
- `reflect`'s lens table, which loses its Model column.
- The elevated-risk rule in all three instruction files keeps two reviewers with different questions and drops "one on an alternate model".

### Checks

- **agent-kit `scripts/validate`** runs `agentic roles check --repo`. It parses the roles and the catalog, then renders both harnesses in memory twice: with no overlay and with `roles/fixtures/no-anthropic.json`. It fails on any error, on any `opencode/` string, and on a model ID shaped like `claude-<digit>`, `claude-<word>-<digit>` or `gpt-<digit>` in `claude/`, `codex/`, `pi/AGENTS.md` or `skills/`, so the prose cannot grow a table back.
- **Tests** cover: an unknown role, model or key; an effort the model does not accept; a missing `reason`; `unavailable` without rebinding; a byte-identical rerender; drift detection; a foreign file kept; and read-only rendering in each harness.
- **bootstrap `install.sh doctor`** runs `agentic roles check` against the machine overlay and the installed directories.

### Who writes what

| File | Writer | On `install.sh` rerun |
| --- | --- | --- |
| `agent-kit/roles/*.md`, `roles/catalog.json` | the user, by PR | read only |
| `~/.config/bootstrap/roles.json` | the user, in private dotfiles | read only |
| `<harness>/agents/<role>.*`, `roles.md`, `roles-session-start.json`, `roles.json` | `install.sh` through `agentic roles render`, recorded in `state.tsv` | rendered to a temporary directory, validated, and moved into place only when the bytes differ. A file at a role's path that bootstrap did not record is kept and reported as foreign. |
| hook entries in `claude/settings.json` and `codex/hooks.json` | bootstrap, by PR | the existing `render_config` path |
| `~/.codex/config.toml` | the user (bootstrap copies it once) | untouched. Its `[agents]` default stays the binding for untyped spawns, which the instructions make the exception. |

Running install twice writes nothing the second time. When render fails, the step returns 1 and the previously rendered files stay in place, consistent with each other.

### Module map

```
agent-kit/
  roles/{explore,quick,build,review}.md   opinion and charters (source of truth)
  roles/catalog.json                   models, efforts, per-harness launch spelling
  roles/fixtures/no-anthropic.json     overlay fixture for validate
  roles/README.md                      change a binding, add a role, write an overlay
  agentic/tools/roles/{roles.ts,cli.ts,roles.test.ts}
  agentic/bin/agentic                  + roles
  claude/CLAUDE.md, codex/AGENTS.md, pi/AGENTS.md   role paragraph replaces table and sentence
  skills/...                           role names replace "different model family"
  scripts/validate                     + agentic roles check --repo
bootstrap/
  install.sh                           render_roles in step_claude and step_codex; doctor runs check
  claude/settings.json, codex/hooks.json   + SessionStart hook
  README.md                            document ~/.config/bootstrap/roles.json
```

### What it does not do

- No router or classifier. The parent picks the role from the task it already understands.
- No automatic fallback, and no ordered list of preferences.
- No per-launch model or effort overrides. A role fixes both. A harder variant is a new role. Codex could not honor a per-launch override anyway, because the agent file's value takes precedence.
- No generated instruction files.
- Nothing for Pi yet. The catalog has Pi's spelling slot, and the Pi render arrives with the Pi project. That project also retires bootstrap's `pi/agents` model choices and its `opencode/*` routes.

## Vendor and pi-subagents guidance

Checked 2026-10-12 against the Claude Code docs (code.claude.com/docs/en/sub-agents, best-practices), the Codex docs (learn.chatgpt.com/docs/agent-configuration/subagents, config reference), and the user's pi-subagents fork (`docs/agents.md`, `docs/models.md`, `skills/pi-subagents/references/prompting-and-roles.md`, from a local worktree that may be newer than bootstrap's pin).

- **One file per agent, model in the file.** All three use one definition per agent: Markdown with frontmatter (Claude, Pi) or TOML (Codex), carrying model, effort, tools and a system prompt. Claude says "design focused subagents" and "limit tool access". Codex says "the best custom agents are narrow and opinionated". This design follows that shape.
- **Built-in roles can be overridden by name.**
  - Claude ships `Explore`, `Plan` and `general-purpose`.
  - Codex ships `default`, `worker` and `explorer`.
  - pi-subagents ships `scout`, `researcher`, `worker`, `reviewer`, `oracle` and `delegate`, and advises overriding built-ins before copying agent files.

  The `explore` role overrides Claude's `Explore`, as the user decided. Codex's built-ins cannot take Claude models, so they stay as they are.
- **Who wins on model choice differs.**
  - Codex: the agent file's model and effort beat spawn values.
  - Claude: a per-launch `model` beats the frontmatter.
  - Pi: a per-run override beats the frontmatter.

  So only in Codex does the role binding hold against a parent that passes its own model. Elsewhere the instruction does the holding, and the review record shows the model that ran.
- **Different models for review.** Neither vendor asks for a different model family. Claude's best practices ask for a fresh context: "the agent doing the work isn't the one grading it". This matches the reviewer definition used here.
- **Model per task.** Claude: Haiku for fast, simple work. Codex: `gpt-6.1-sol` for "demanding agents", and `gpt-6-luna` for "fast, narrowly scoped agents handling clear, repeatable, or high-volume work", which supports option (b) of open question 2. The pi-subagents skill: workers and scouts on a fast tier, serious reviews on the strong tier at high thinking, and "explicit parent/user model policy wins".
- **When not to delegate.** Anthropic's Opus 5 prompting guide: "Do not delegate work you can finish yourself in a handful of tool calls." The role paragraph should carry this for `quick`.

## Synthesis decision

**Base: candidate C** (roles as the unit, rendered into each harness). It is the only candidate where the role name is also the native agent name in every harness. That makes the common launch one call, needs no lookup, and keeps the instruction files as symlinks.

**Grafted from B** (one policy compiled into each machine's instruction files):

- Overlay replacements require a `reason`, which the table prints.
- The overlay is strict: no `null`, `auto` or `inherit-parent`.
- The rule "native, then T3, then stop; never relaunch elsewhere after an accepted launch".

**Grafted from A** (one TOML file of kinds, with an ordered preference list per kind):

- Every review record names the model that ran.
- The no-model-IDs check extends to `skills/`.

A's per-kind `stay_native` idea became open question 2.

**Added after checking the facts:**

- Codex has a `SessionStart` hook with `additionalContext`. That removes C's one extra read for Codex parents, and both harnesses now get the table the same way.
- Two claims were confirmed in the docs: Claude agent files accept full model IDs and `effort` (code.claude.com/docs/en/sub-agents), and Codex reads `~/.codex/agents/*.toml`, where the file's model and effort take precedence over spawn values (developers.openai.com/codex/subagents).
- C's rule allowing per-launch effort raises is dropped, so there is one way to set effort.
- C's Pi render is deferred.

**Rejected:**

- **B's generation directories with an atomic pointer, which turn the instruction files into generated copies.** This breaks live development through `BOOTSTRAP_AGENT_KIT` and adds machinery that only versioning needs.
- **B's rule that Claude roles launch only through T3, even from Claude Code.** B said native aliases cannot pin a versioned model. Agent files can: they accept full IDs and `effort`.
- **A's ordered `prefer` lists, which fall back automatically to a second model.** agent-kit would be guessing each machine's second choice, at launch time.
- **A's and B's marker blocks rendered into the instruction files.** Same cost as B's generations.

**Dropped:** candidate A has no `design.md`. Its sketch (`kinds.toml`, signatures, a plan trace) was read and scored as partial.

### Rubric scores (1 to 3)

| Criterion | A (partial) | B | C | Synthesis |
| --- | --- | --- | --- | --- |
| One source, drift fails a check | 3 | 3 | 3 | 3 |
| Update cost: one file, one PR; overlays never fork the opinion | 3 | 3 | 3 | 3 |
| Honest about reach, no silent substitution | 2 (automatic fallback) | 3 | 3 | 3 |
| Agent acts from context, text stays short | 2 | 3 | 2 (Codex reads a file) | 3 |
| Finer roles are additive | 3 | 3 | 3 | 3 |
| Fits bootstrap and agent-kit, no service | 1 (generated instructions) | 1 (generations, pointer) | 3 | 3 |

No separate judge ran. The skill makes one optional, and the scores above are mine.

## Tradeoffs accepted

- We accept that cross-provider roles need T3 in exchange for having no runtime router. Outside T3, a Claude parent cannot run `review` and a Codex parent cannot run `quick` or `build`. Both report the role as unavailable.
- We accept read-only enforcement by tool restriction rather than by sandbox, in exchange for reviewers that can still run the product and write evidence. Claude loses `Edit`, `Write` and `NotebookEdit`. Codex stays at the user's sandbox: `sandbox_mode = "read-only"` in an agent file would not be a boundary anyway, because Codex reapplies the parent turn's live runtime overrides (such as full access) when it spawns a child. A sandboxed `verify` role is the later split.
- We accept that rendered files are copies in exchange for symlinked instructions: a role change goes live only after `install.sh link`.
- We accept Codex's `[agents]` default (`gpt-6-astra` at `low`) for untyped spawns, because `config.toml` belongs to the user after the first copy.
- We accept that a parent can still pass `model` to Claude's Agent tool and override a role, in exchange for not building an enforcement hook now. The instruction forbids it, and the review record names the model that ran.

## Alternatives considered

- **Hand-synced prose tables in each harness** (the status quo). Three copies, already out of date, and no machine overrides.
- **One `roles.json` imported into `CLAUDE.md` with `@import`.** Codex cannot import, and an import inside a symlinked file has undocumented path semantics.
- **An agent-kit MCP server with `resolve(role)` or `launch(role, brief)` tools.** All three harnesses support MCP, but a server cannot do the parts that matter:
  - It cannot register native agent types. Claude Code's own routing to `Explore`, and Codex's `agent_type`, read only agent files. So the files are needed anyway, and an MCP path would be a second way to do one task.
  - `resolve` spends a tool call per launch on an answer that is fixed per machine at install time. The `SessionStart` table gives the same answer with no call.
  - `launch` would be a second executor beside T3's `delegate_task`. The Hermes and pi-t3-runtime designs give T3 sole ownership of delegated launches.
  - It costs a server process in every session, tool schemas in context, and MCP registration in each harness, which bootstrap would have to keep in step with the agent-kit pin.

  Enforcing the binding is a hook's job, not a server's: a Claude `PreToolUse` hook on `Agent` can refuse a launch that passes its own `model`.
- **Keeping the opinion in bootstrap**, through Pi agent overrides, Codex `[agents]`, or agent files. Wrong owner by the user's decision, and it is how the OpenCode routes crept in.
- **pstack's setup skill, which writes one always-applied rule.** Its override semantics are right (one line per role, delete a line to fall back, values validated), and the overlay keeps them. But the skill is interactive, Cursor-only, and produces no native agent files.

## Open questions

1. **Efforts.** Options:
   - (a) `quick` medium, `build` high, `review` xhigh.
   - (b) low, high, high, which A and B proposed.

   I recommend (a). Medium is Haiku 5.5's default in T3's catalog, so `quick` claims no tuning that nobody has measured. High is one step above Opus 5.5's default of medium, because implementation is the work that most needs it. Xhigh matches both reviewer configs the user already wrote (bootstrap `pi/settings.json` and pi-t3-runtime's reviewer profile). If review effort is left unstated, T3 runs `gpt-6.1-sol` at its catalog default of `low`. Against this, the Codex docs suggest `high` for "reviewer or security-focused agents", and their example reviewer runs `gpt-6.1-sol` at `medium`. Default: (a), revisited once routing records show cost and quality.

2. **Cross-harness `quick` and `explore`.** From Codex, either role on Haiku means a T3 child thread per lookup, and it is unavailable outside T3. Options:
   - (a) Strict: T3 or unavailable.
   - (b) A role file may declare a per-harness binding, such as `codex: {model: gpt-6-luna, effort: low}`. The table shows it, so it is not a substitution.
   - (c) A's ordered fallback list.

   I recommend (b), for `explore` and `quick` only: those roles exist to be cheap, and a cross-provider thread defeats that. Default: (a) until answered.

3. **Model diversity among design-checkpoint candidates.** This is separate from reviewer independence. pstack holds that "different models have different blind spots". Options:
   - (a) Candidates run as `build`, and diversity comes from independent briefs.
   - (b) Keep a "different model families across candidates" exception, launched through T3.

   I recommend (b): candidate diversity is what the step is for, and it is cheap at two or three launches. Default: (b).

   Reopened and decided by the user on 2026-10-13: the preference is removed. Subagents are Claude-only, after a candidate sent to another provider stalled a trial.

4. **Role names.** `explore`, `quick`, `build`, `review`. Alternatives: `bulk`/`implementation`/`review` (B), or `quick`/`implement`/`review` (A). I recommend the short verbs, because they are one word, read as agent types, and do not collide with skill names. Default: `explore`, `quick`, `build`, `review`.

5. **Claude's built-in `Explore`.** Decided by the user on 2026-10-12: `Explore` runs on `claude-haiku-5-5`. The design now has an `explore` role that renders as Claude's `Explore` agent (see Roles and Source of truth).

6. **Usage limits.** Two of the three design candidates for this document died on a Claude session limit. pi-subagents handles this with `fallbackModels`, which applies only to quota, auth, timeout and unavailable-model errors, is reported in the output, and is recorded in `status.json`. Options:
   - (a) Stop and report, as written above.
   - (b) A role may declare one `onLimit` binding, which the parent uses only after a provider-limit error and names in its report.

   I recommend (b): it is declared and reported, so it is not a silent substitution, and limits are the failure seen in practice. Default: (a) until answered.

## Risks to verify while building

- **Codex `SessionStart` output.** The schema is from the binary. Slice 2 runs the hook and checks that the table appears in Codex's context.
- **Codex agent discovery and `$CODEX_HOME`.** The docs say `~/.codex/agents/`. On this machine `CODEX_HOME` is `~/.codex`. Slice 2 confirms that the spawn tool lists `review`.
- **`SessionStart` inside subagents.** If children also see the table, it costs context but is harmless, since children do not delegate.
- **Claude Code's minimum version for `effort`.** The docs give v2.1.292 for the per-invocation parameter. The installed version is 2.1.296. `doctor` checks the version, so an effort is never silently dropped.

## First implementation step

On `agent/model-roles`, add `roles/` (four roles, catalog, fixture) and `agentic/tools/roles/` with `loadRoles`, `loadCatalog`, `parseOverlay`, `resolve`, `launchFor` and `render` for both harnesses, plus `agentic roles check --repo` in `scripts/validate`. It is done when:

- `agentic roles render --harness claude` writes `agents/Explore.md`, `agents/quick.md`, `agents/build.md`, `roles.md` and `roles.json`, and no `agents/review.md`.
- The Codex render writes only `agents/review.toml` plus the table files.
- The no-Anthropic fixture renders with both overrides named.
- An overlay that marks `anthropic` unavailable without rebinding is refused with exit 1 and writes nothing.
- Copying the Claude agent files into `~/.claude/agents/` makes `build` and `quick` appear in `/agents` with the right model and effort.

The later slices, in order: the bootstrap install step and the hooks, then the wording in instructions and skills.

## Rubric used

1. One source of truth: each role's model binding lives in one agent-kit file, every consumer derives from it, and a check fails on drift.
2. Update cost: changing or adding a role is one file in one PR, and a machine override never forks the opinion.
3. Honest about reach: for each harness, it says how each role launches and what happens when the model cannot be reached, with no silent substitution.
4. Agent ergonomics: the agent can act from context in the common case, and the text in context stays short.
5. Growth: finer roles are additive.
6. Fit: it reuses bootstrap's render and overlay and agent-kit's patterns, adds no runtime service, and needs nothing that stock Codex forbids.
