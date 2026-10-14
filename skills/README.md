# Shared agent skills

Pi loads this library directly. Codex exports the reviewed selection in
[`codex/skills.txt`](../codex/skills.txt) through the standard shared skill directory;
see [the Codex instructions](../codex/AGENTS.md). Runtime-specific behavior stays in explicit
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
`11713c683fe4add4fd403ea880580abbc9e0875f`; [`RESYNC.md`](RESYNC.md) records what the
resync took and rejected.

Six pstack principle skills are kept close to the upstream text as reference files inside the skill each
one belongs to, rather than as skills. Five were adapted at `9f451cf875ad1239912762f67741e8e5ba6ac0f1` and
resynced to `11713c683fe4add4fd403ea880580abbc9e0875f`; `build-the-lever` was adapted at
`11713c683fe4add4fd403ea880580abbc9e0875f`, with delegate skills replaced by a shared brief. `verification` holds
`test-behavior-not-implementation` and `explain-the-number`, `code-design` holds `laziness-protocol`,
`subtract-before-you-add`, and `build-the-lever`, and `diagnosing-bugs` holds `attack-the-premise`. pstack reaches its principles
through `poteto-mode`, a mode skill with no equivalent here, so each parent skill says when to read its file.

Local adaptations use narrow automatic triggers, remove Cursor tools, model routing,
MCP assumptions, cross-skill invocation, and publication behavior, and preserve evidence
and source boundaries. The upstream MIT license is preserved in `PSTACK-LICENSE`.

The `code-design`, `git-workflow`, `github-rulesets`, `new-project`, `repo-baseline`, `technology-selection`, `source-grounded-research`, `spike`, and `verification` skills are original to this repository. `git-workflow`'s `references/pr-review.md` condenses the reviewer prompt and rubric of pstack's `interrogate` (MIT, `PSTACK-LICENSE`) into one fresh reviewer, adds a precedent lens and the repository's review rules, and drops the multi-model panel and Cursor tooling.

The `feature-shaping` skill is original to this repository. Its risk-scaled design workflow
is informed by HumanLayer's
[Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md)
and Maciej Dziuba's
[Software Factory Playbook gist](https://gist.github.com/Maciejdziuba/88890d7e0eeefa5a8738bbe9fd5e20b8).
Neither source is vendored.

## Agentic judgment skills

The `babysit-and-ship`, `background-run`, `correct`, `create-verification`, `design-checkpoint`,
`maintain-verification`, `prototype-to-decide`, `reflect`, `show-me-your-work`, and `teach` skills are
the judgment layer of the agentic stack. They were written for the agentic prototype and are adapted
and condensed from [cursor/plugins](https://github.com/cursor/plugins) at commit
`9f451cf875ad1239912762f67741e8e5ba6ac0f1`, mostly pstack (MIT, `PSTACK-LICENSE`). The web and
CLI recipes in `create-verification` come from cursor-team-kit (MIT, copyright Cursor, preserved in
`CURSOR-TEAM-KIT-LICENSE`); its systems and games recipes are original.

| Skill | Invocation | Upstream sources |
| --- | --- | --- |
| [correct](correct/SKILL.md) | manual | `pstack/skills/correct/` |
| [create-verification](create-verification/SKILL.md) | model and manual | `pstack/skills/create-verification-skill/`; recipes from `cursor-team-kit/skills/control-ui/` and `cursor-team-kit/skills/control-cli/`; the control CLI is informed by `cli-for-agent/skills/cli-for-agents/` and `pstack/docs/guide/06-verify-and-ship.md`, not vendored |
| [maintain-verification](maintain-verification/SKILL.md) | manual | `pstack/skills/maintain-verification-skill/` |
| [teach](teach/SKILL.md) | model and manual | `pstack/skills/teach/`; the failure and surprise trigger is from design D6 |
| [show-me-your-work](show-me-your-work/SKILL.md) | model and manual | `pstack/skills/show-me-your-work/` |
| [reflect](reflect/SKILL.md) | manual | `pstack/skills/reflect/`; the learning-file output is from design D9 |
| [design-checkpoint](design-checkpoint/SKILL.md) | model and manual | `pstack/skills/architect/`, `pstack/skills/arena/` |
| [prototype-to-decide](prototype-to-decide/SKILL.md) | model and manual | `pstack/skills/poteto-mode/playbooks/prototype.md` |
| [background-run](background-run/SKILL.md) | manual | `pstack/skills/poteto-mode/playbooks/autonomous-run.md`, `pause-safely.md`, `session-pickup.md`, `orchestrate.md`; `pstack/skills/figure-it-out/`; `pstack/docs/guide/07-overnight.md` |
| [babysit-and-ship](babysit-and-ship/SKILL.md) | model and manual | `pstack/skills/poteto-mode/playbooks/babysit.md`, `shipping.md`, `opening-a-pr.md`, `autopilot-full.md`; `pstack/skills/poteto-mode/references/bugbot-triage.md` |

Local adaptations:

- Tools are called through the `agentic` CLI (`agentic rulesets`, `agentic upstream-drift`,
  `agentic verify`, `agentic orch`, `agentic watch-pr`, `agentic jev`, `agentic pr-feedback`). The decision log is a plain TSV appended
  with pstack's `show-me-your-work/scripts/log.sh`. Paths under `.agents/` and `.audit/` are relative
  to the repository being worked on; never copy a tool into it.
- The wording is runtime-neutral so one copy serves Pi and the Claude export.
- Publication follows the standing default in the instructions; landing happens only in the
  `autopilot-stack`, `ship`, and `autopilot-full` modes that `babysit-and-ship` defines, invoked by the user's own
  words, and each merge waits for `agentic verify status` to pass. Messages to people are drafted
  for the user, and a blocked or denied action is final.
- Expensive or side-effecting workflows set `disable-model-invocation: true`, unless the user's words
  are what starts them: `babysit-and-ship` loads when the user's words name a landing mode, and
  `create-verification` when such a mode needs a verification skill first.
- Transcripts are read only for the active workspace's current session, except that a session pickup reads the prior run it resumes in the same workspace.
- Decision logs, session learning files, and the verdict ledger each have one writer.

## Machine-readable provenance

Read by `agentic upstream-drift`. It covers every skill adapted from cursor/plugins, with one row per
local path and upstream source; a local file merged from several upstream files has a row for each.
A resync advances a row's commit; [`RESYNC.md`](RESYNC.md) records what each resync took and rejected.

| Local | Upstream path | Commit |
| --- | --- | --- |
| `skills/unslop` | `pstack/skills/unslop` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/technical-writing` | `pstack/skills/technical-writing` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/how` | `pstack/skills/how` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/why` | `pstack/skills/why` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/blast-radius` | `pstack/skills/blast-radius` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/make-operations-idempotent` | `pstack/skills/principle-make-operations-idempotent` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/separate-before-serializing-shared-state` | `pstack/skills/principle-separate-before-serializing-shared-state` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/type-system-discipline` | `pstack/skills/principle-type-system-discipline` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/verification/references/test-behavior-not-implementation.md` | `pstack/skills/principle-test-behavior-not-implementation/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/code-design/references/laziness-protocol.md` | `pstack/skills/principle-laziness-protocol/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/code-design/references/subtract-before-you-add.md` | `pstack/skills/principle-subtract-before-you-add/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/code-design/references/build-the-lever.md` | `pstack/skills/principle-build-the-lever/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/verification/references/explain-the-number.md` | `pstack/skills/principle-explain-the-number/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/diagnosing-bugs/references/attack-the-premise.md` | `pstack/skills/principle-attack-the-premise/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/correct` | `pstack/skills/correct` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/git-workflow/references/pr-review.md` | `pstack/skills/interrogate/references/reviewer-prompt.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/git-workflow/references/pr-review.md` | `pstack/skills/interrogate/references/rubric.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/create-verification` | `pstack/skills/create-verification-skill` | `997ffc7fe26bdaa6478a14e7f5b8d5f9ed747102` |
| `skills/create-verification/references/web.md` | `cursor-team-kit/skills/control-ui/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/create-verification/references/cli-tui.md` | `cursor-team-kit/skills/control-cli/SKILL.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/maintain-verification` | `pstack/skills/maintain-verification-skill` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/teach` | `pstack/skills/teach` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/show-me-your-work` | `pstack/skills/show-me-your-work` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/reflect` | `pstack/skills/reflect` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/design-checkpoint` | `pstack/skills/architect` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/design-checkpoint/references` | `pstack/skills/arena` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/prototype-to-decide` | `pstack/skills/poteto-mode/playbooks/prototype.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/background-run` | `pstack/skills/poteto-mode/playbooks/autonomous-run.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/background-run/references/pause-and-pickup.md` | `pstack/skills/poteto-mode/playbooks/pause-safely.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/background-run` | `pstack/skills/figure-it-out` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/background-run` | `pstack/docs/guide/07-overnight.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/background-run/references/pause-and-pickup.md` | `pstack/skills/poteto-mode/playbooks/session-pickup.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/background-run/references/coordination.md` | `pstack/skills/poteto-mode/playbooks/orchestrate.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/babysit-and-ship` | `pstack/skills/poteto-mode/playbooks/babysit.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/babysit-and-ship/references/shipping.md` | `pstack/skills/poteto-mode/playbooks/shipping.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/babysit-and-ship/references/autopilot-full.md` | `pstack/skills/poteto-mode/playbooks/autopilot-full.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/babysit-and-ship/references/pr-body.md` | `pstack/skills/poteto-mode/playbooks/opening-a-pr.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |
| `skills/babysit-and-ship/references/bot-triage.md` | `pstack/skills/poteto-mode/references/bugbot-triage.md` | `11713c683fe4add4fd403ea880580abbc9e0875f` |

## Skill boundaries

Every installed skill owns a self-contained primary workflow and may read references within
its own directory. Global agent policy may run `unslop` as a separate final pass over an
artifact's prose; the primary skill does not invoke it from within its workflow. The agentic
judgment skills may name another skill for a step that skill owns (for example, `background-run`
defers the Attention review to `show-me-your-work`) and never restate that procedure. `new-project` is a router on the same terms: each of its steps names the skill that owns it.
