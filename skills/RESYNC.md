# Upstream resyncs

Each section records one reviewed resync of a skill adapted from
[cursor/plugins](https://github.com/cursor/plugins): the upstream range, each upstream change, and
whether it was taken or rejected and why. The resync commit advances the skill's row in the
machine-readable provenance table in [`README.md`](README.md). Run `agentic upstream-drift` to see
which rows have upstream changes to review, then read them with
`git -C <cursor-plugins> diff <row commit> HEAD -- <upstream path>`.

Changes are rejected when they bring in Cursor tools, model routing, MCP assumptions, publication
behavior outside the autonomy ladder, or a restatement of a rule the policy layer enforces, or when
they edit text the local adaptation does not contain. The local adaptations of the 68836dd skills
are rewrites rather than copies, so most upstream wording edits have no local counterpart.

## 2026-10-07: skills adapted at 68836dd, resynced to 9f451cf

### unslop

Upstream: `pstack/skills/unslop`, `68836dd..9f451cf` (commits 73f8be4, e8d856f, 70b2dc8).

| Upstream change | Decision | Reason |
| --- | --- | --- |
| Rule 32, mannered prose (aphorisms, personified code, figurative verbs) | Taken | A real tell the local list lacked; added as a pattern bullet in section 2. |
| Rule 33, over-compression (dropped articles, verbless fragments, arrows) | Taken | Same; added as a pattern bullet in section 2. |
| `disable-model-invocation: true` | Rejected | Global policy runs `unslop` as a model-invoked final pass. |
| Remove the "What makes this obviously AI generated?" self-audit step | Rejected | The local final audit checks preserved facts and invented content, which the removal did not address. |
| Remove the "Adding soul" section and "add human voice" | No local change | The local skill never adopted it; section 4 already forbids manufactured personality. |
| Remove puffery, name-dropping, promotional, formulaic-challenge, and cutoff-disclaimer rules | Rejected | The local list folds these into two context-judged bullets that still catch real tells in public prose. |
| Stable rule numbers that other skills cite | Rejected | Local patterns are unnumbered; skills do not cite another skill's rules. |
| Drop the em-dash rationale sentence | No local change | The local skill has no such sentence. |

### technical-writing

Upstream: `pstack/skills/technical-writing`, `68836dd..9f451cf` (commits e8d856f, d7cde2b, 70b2dc8, 23e4138). No change taken.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| Propose new jargon offenders in the reply instead of editing `unslop` | No local change | The local skill does not reference `unslop`; each skill is self-contained. |
| A PR body is a briefing read in under a minute; link logs, SHA lists, and metric tables | Rejected | `babysit-and-ship/references/pr-body.md` owns PR bodies and already says this. This skill covers durable documents. |
| Remove the review checklist, the worked-example commentary, the "read it aloud" and "gut feel" lines, and the source citations | No local change | The local rewrite never adopted them. |
| Replace semicolons with periods | No local change | The local rewrite does not contain the edited sentences. |

### how

Upstream: `pstack/skills/how`, `68836dd..9f451cf` (commits 73f8be4, 23a56e2, e8d856f, d7cde2b, 70b2dc8, 12d587d, df58112). No change taken.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| Remove critique mode, `references/critic-prompt.md`, and `references/critique-rubric.md` | Rejected | Upstream removed a multi-model critic pipeline that the local skill never adopted. Local section 5 is a short guard used only on request (explain first, tie each criticism to an observed cost), and no other local skill critiques existing architecture. |
| `disable-model-invocation: true` | Rejected | The local skill is model-invoked through a narrow description. |
| Read subagent models from `pstack-models.mdc`, with new default models | Rejected | Model routing. |
| Shorter complexity assessment ("when in doubt, take the simple path") | No local change | Local section 2 already splits work into read-only lanes only when their scopes are distinct. |
| Wording edits in `references/explainer-prompt.md` and `references/explorer-prompt.md` | No local change | The local skill has no prompt templates. |

### why

Upstream: `pstack/skills/why`, `68836dd..9f451cf` (commits 73f8be4, 23a56e2, e8d856f, d7cde2b, 70b2dc8, 12d587d, df58112). No change taken.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| `disable-model-invocation: true` | Rejected | The local skill is model-invoked through a narrow description. |
| Read investigator and synthesizer models from `pstack-models.mdc`, with new default models | Rejected | Model routing. |
| Density cuts to the MCP discovery, the seven investigator categories, the operating posture, the output format, and the failure modes | No local change | The local skill replaced the MCP fan-out with a read-only source order (code, git history, documents, linked issues) and its own evidence grades, so it contains none of the cut text. |
| Punctuation edits in the reference prompts, the epistemics guide, and the MCP source playbooks | No local change | The local skill has no references; the playbooks assume MCP servers. |

### blast-radius

Upstream: `pstack/skills/blast-radius`, `68836dd..9f451cf` (commits e8d856f, d7cde2b, 70b2dc8, df58112). No change taken.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| Drop "Any safety fact you can't get to step 4, say so out loud" and "If you can't prove it cheaply, mark it unproven. Don't round up." | Rejected | Marking unproven claims carries the evidence rule; local section 4 keeps it. Upstream still asks for "unproven" in its hand-back list, so the cut removed repetition rather than the rule. |
| Drop "Only the real ones" from the risks item | No local change | The local report already separates confirmed risks from cleared paths. |
| "scary" to "risky", "several models" to "more than one model" in the arena step, and other tightening | No local change | The local rewrite does not contain these sentences and has no multi-model arena step. |

### separate-before-serializing-shared-state

Upstream: `pstack/skills/principle-separate-before-serializing-shared-state`, `68836dd..9f451cf` (commits e8d856f, d7cde2b). No change taken.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| Drop "truly" and "Telling agents or goroutines to take turns does not work"; replace a semicolon with a period | No local change | The local rewrite does not contain these sentences. Local section 3 already says conventions are not concurrency control. |

### type-system-discipline

Upstream: `pstack/skills/principle-type-system-discipline`, `68836dd..9f451cf` (commits e8d856f, d7cde2b). No change taken.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| Drop "Manual duplication drifts" and "Extra precision costs reuse and ceremony and buys no safety" | Rejected | The local skill keeps both points (sections 5 and 6) because they justify its stopping rule. |
| Drop "worth naming" and the "cast you bury today" aphorism; replace semicolons with periods | No local change | The local rewrite does not contain these sentences. |

### make-operations-idempotent

Upstream: `pstack/skills/principle-make-operations-idempotent`, unchanged between 68836dd and 9f451cf. Nothing to review; the provenance row advances to record that the skill is current.

### diagnosing-bugs

Upstream: `mattpocock/skills` `skills/engineering/diagnosing-bugs`, `6654f6b..f3fc563`.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| After watching a forced failure, diff against a pristine copy to prove the mutation landed | Taken | It closes a real gap in the local reproduce-then-fix step: a red caused by a mutation that never landed proves nothing. |
| Read `GLOSSARY.md` instead of `CONTEXT.md` | No local change | The local adaptation names neither file. |

### show-me

Upstream: `humanlayer/skills` `plugins/show-me/skills/show-me`, `3c26291..ca7c808`. No change taken.

| Upstream change | Decision | Reason |
| --- | --- | --- |
| `disable-model-invocation: true` (user invocation only) | Rejected | The local description already limits automatic use to an explicit request to show or diagram something; a natural-language request should still reach the skill, not only the command form. |
| Agent metadata for another harness (`agents/openai.yaml`) | No local change | Not part of the adapted skill. |
