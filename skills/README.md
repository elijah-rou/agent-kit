# Shared agent skills

Pi loads this library directly. Codex exports the reviewed selection in
[`codex/skills.txt`](../../codex/skills.txt) through the standard shared skill directory;
see [the Codex guide](../../codex/README.md). Runtime-specific behavior stays in explicit
branches, so the two consumers do not need separate copies.

The `show-me` and `design-control-loop` skills are adapted from
[humanlayer/skills](https://github.com/humanlayer/skills) at commit
`3c2629142c5d437428269b1b722b08c0b87f574d`.

Local adaptations narrow automatic invocation, use portable skill paths, require an
approved control-loop design before implementation, and tighten workflow safety.
Both are reviewed against `ca7c8088db69e315a8b2deea43820270457f8f3c` ([`RESYNC.md`](RESYNC.md)); drift is tracked in `provenance.toml`.
The upstream MIT license is preserved in `HUMANLAYER-LICENSE`.

The `writing-for-agents` and `diagnosing-bugs` skills are adapted from
[mattpocock/skills](https://github.com/mattpocock/skills) at commit
`6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`.

Local adaptations support Pi and Codex skill contracts, narrow automatic triggers, remove
foreign-harness orchestration and implicit publication, and keep application debugging
separate from the coredump workflow. `diagnosing-bugs` is resynced to
`f3fc5632f401156837ee3872f14fe33ccf1024ea` ([`RESYNC.md`](RESYNC.md)); drift is tracked in `provenance.toml`.
The upstream MIT license is preserved in `POCOCK-LICENSE`.

The `unslop`, `technical-writing`, `how`, `why`, `blast-radius`,
`make-operations-idempotent`, `separate-before-serializing-shared-state`, and
`type-system-discipline` skills are adapted from
[cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack/skills) at commit
`68836ddaf5697224520f1847d90cdb90ca8babaa` and resynced to
`9f451cf875ad1239912762f67741e8e5ba6ac0f1`; [`RESYNC.md`](RESYNC.md) records what the
resync took and rejected.

Local adaptations use narrow automatic triggers, remove Cursor tools, model routing,
MCP assumptions, cross-skill invocation, and publication behavior, and preserve evidence
and source boundaries. The upstream MIT license is preserved in `PSTACK-LICENSE`.

The `code-design`, `git-workflow`, `github-rulesets`, `technology-selection`, `source-grounded-research`, and `verification` skills are original to this repository.

The `feature-shaping` skill is original to this repository. Its risk-scaled design workflow
is informed by HumanLayer's
[Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md)
and Maciej Dziuba's
[Software Factory Playbook gist](https://gist.github.com/Maciejdziuba/88890d7e0eeefa5a8738bbe9fd5e20b8).
Neither source is vendored.

## Agentic judgment skills

The `correct`, `create-verification`, `design-checkpoint`, `maintain-verification`,
`prototype-to-decide`, `reflect`, and `teach` skills are the judgment layer of the agentic stack;
`github-rulesets` is original. `babysit-and-ship`, `background-run`, and `show-me-your-work` are parked
on the `agent/reference-full-stack` branch until the tooling they rely on earns its place
([`docs/analysis/2026-10-07-augmentation-vs-cruft.md`](../docs/analysis/2026-10-07-augmentation-vs-cruft.md)). They were written for the agentic prototype and are adapted
and condensed from [cursor/plugins](https://github.com/cursor/plugins) at commit
`9f451cf875ad1239912762f67741e8e5ba6ac0f1`, mostly pstack (MIT, `PSTACK-LICENSE`). The web and
CLI recipes in `create-verification` come from cursor-team-kit (MIT, copyright Cursor, preserved in
`CURSOR-TEAM-KIT-LICENSE`); its systems and games recipes are original.

| Skill | Invocation | Upstream sources |
| --- | --- | --- |
| [correct](correct/SKILL.md) | manual | `pstack/skills/correct/` |
| [create-verification](create-verification/SKILL.md) | manual | `pstack/skills/create-verification-skill/`; recipes from `cursor-team-kit/skills/control-ui/` and `cursor-team-kit/skills/control-cli/` |
| [maintain-verification](maintain-verification/SKILL.md) | manual | `pstack/skills/maintain-verification-skill/` |
| [teach](teach/SKILL.md) | model and manual | `pstack/skills/teach/`; the failure and surprise trigger is from design D6 |
| [reflect](reflect/SKILL.md) | manual | `pstack/skills/reflect/`; the learning-file output is from design D9 |
| [design-checkpoint](design-checkpoint/SKILL.md) | model and manual | `pstack/skills/architect/`, `pstack/skills/arena/` |
| [prototype-to-decide](prototype-to-decide/SKILL.md) | model and manual | `pstack/skills/poteto-mode/playbooks/prototype.md` |

Local adaptations:

- Tools are called through the `agentic` CLI (`agentic rulesets`, `agentic upstream-drift`). Paths
  under `.agents/` are relative to the repository being worked on; never copy a tool into it.
- The wording is runtime-neutral so one copy serves Pi and the Claude export.
- Messages to people are drafted for the user, and a blocked or denied action is final.
- Expensive or side-effecting workflows set `disable-model-invocation: true`.
- Transcripts are read only for the active workspace's current session.
- Session learning files have one writer: the session that produced them.

## Machine-readable provenance

Read by `agentic upstream-drift`. It covers every skill adapted from cursor/plugins, with one row per
local path and upstream source; a local file merged from several upstream files has a row for each.
A resync advances a row's commit; [`RESYNC.md`](RESYNC.md) records what each resync took and rejected.

| Local | Upstream path | Commit |
| --- | --- | --- |
| `skills/unslop` | `pstack/skills/unslop` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/technical-writing` | `pstack/skills/technical-writing` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/how` | `pstack/skills/how` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/why` | `pstack/skills/why` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/blast-radius` | `pstack/skills/blast-radius` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/make-operations-idempotent` | `pstack/skills/principle-make-operations-idempotent` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/separate-before-serializing-shared-state` | `pstack/skills/principle-separate-before-serializing-shared-state` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/type-system-discipline` | `pstack/skills/principle-type-system-discipline` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/correct` | `pstack/skills/correct` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/create-verification` | `pstack/skills/create-verification-skill` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/create-verification/references/web.md` | `cursor-team-kit/skills/control-ui/SKILL.md` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/create-verification/references/cli-tui.md` | `cursor-team-kit/skills/control-cli/SKILL.md` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/maintain-verification` | `pstack/skills/maintain-verification-skill` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/teach` | `pstack/skills/teach` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/reflect` | `pstack/skills/reflect` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/design-checkpoint` | `pstack/skills/architect` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/design-checkpoint/references` | `pstack/skills/arena` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |
| `skills/prototype-to-decide` | `pstack/skills/poteto-mode/playbooks/prototype.md` | `9f451cf875ad1239912762f67741e8e5ba6ac0f1` |

## Skill boundaries

Every installed skill owns a self-contained primary workflow and may read references within
its own directory. Global agent policy may run `unslop` as a separate final pass over an
artifact's prose; the primary skill does not invoke it from within its workflow. The agentic
judgment skills may name another skill for a step that skill owns (for example, `create-verification`
points maintenance at `maintain-verification`) and never restate that procedure.
