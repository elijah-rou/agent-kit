# Upstream resyncs

Each section records one reviewed resync of a skill adapted from
[cursor/plugins](https://github.com/cursor/plugins): the upstream range, each upstream change, and
whether it was taken or rejected and why. The resync commit advances the skill's row in the
machine-readable provenance table in [`README.md`](README.md). Run `agentic upstream-drift` to see
which rows have upstream changes to review, then read them with
`git -C <cursor-plugins> diff <row commit> HEAD -- <upstream path>`.

Changes are rejected when they bring in Cursor tools, model routing, MCP assumptions, publication
behavior outside the standing default in the instructions, or a restatement of a rule a guard enforces, or when
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

## 2026-10-11: cursor/plugins rows resynced from 9f451cf to 11713c6

Upstream commits: 00b14f1 (`refactor(pstack): distill skill prompts to cut tokens`, #538) and 978ca6e (`feat(pstack): add /ketchup skill`, #539). The distill cuts restated "Why" paragraphs, step lists that repeat the headings, and duplicated sentences; it states no new rule. Rows with no upstream change advance with the drifted ones.

| Local | Upstream change | Decision | Reason |
| --- | --- | --- | --- |
| `verification/references/explain-the-number.md` | Drop the opening claim and the "Why" paragraph; fold "why not double" and "code that never ran" into the bullets | Taken | The file tracks upstream text. The local baseline line and the pointer to the instructions' evidence rules stay. |
| `verification/references/test-behavior-not-implementation.md` | Rewrite as one rule, five short failing shapes, one fix paragraph, and the keep list; drop the "Why" paragraph and some matcher examples | Taken | The file tracks upstream text, and the rule and the fixes are unchanged. |
| `code-design/references/subtract-before-you-add.md` | Drop the "Why" paragraph and the "The pattern" label | Taken | Same. |
| `type-system-discipline` | Fold the "tests" list into the pattern bullets and cut the opening | No local change | The local skill is a rewrite with numbered steps and completion criteria; it contains none of the cut text. |
| `babysit-and-ship/references/pr-body.md` | Compress the opening-a-pr sections; move "commit bodies don't restate the subject" into Commits | No local change | The local reference is already condensed and covers only the PR body. |
| `background-run` (figure-it-out) | Shorter description and joined sentences | No local change | Wording only; the local skill does not contain the edited sentences. |
| `design-checkpoint` (architect), `design-checkpoint/references` (arena) | Merge phase paragraphs; arena's Start list becomes one line; the synthesis note gains the cross-judge verdict and convergence | No local change | The local skill has no multi-model arena, and its rationale template already records the chosen shape and rejected candidates. |
| `how`, `why`, `reflect` | Merge the per-step subagent settings into one line, cut repeated posture and process text in the prompts | No local change | The local skills replaced the subagent and MCP pipelines, so none of the cut text exists here. |
| `technical-writing`, `unslop` | Wording cuts inside existing rules | No local change | The local rewrites do not contain the edited sentences. |
| none (new `ketchup` skill) | A command that catches the user up since their last message, with an executive summary for each action item | Not adopted | The instructions' "Needs you" opening and their rule on asking only the user's decisions and reporting the rest, and `show-me-your-work`'s catch-up on a run, cover it. |

## 2026-10-13: create-verification resynced from 11713c6 to 997ffc7

Upstream: `pstack/skills/create-verification-skill`, `11713c6..997ffc7` (commit c49b37a, `fix(pstack): create-verification-skill readiness means the app is usable`, #573).

| Upstream change | Decision | Reason |
| --- | --- | --- |
| Launch reaches a usable state from an empty data directory, including migrations and seed data; ready means usable, not that a process answers; drop "a port answering" from the readiness examples | Taken | A port or health check can answer while initialization still runs, so a drive could start against an unready app. Adapted into the Launch bullet. |
| A journey whose seed data lacks a precondition reports a failure, with the reason in that feature's `Gotchas`; never weaken the journey | Taken | Adapted to the local result lines: a missing seed precondition is `FAIL`, not `SKIP`, because seed data is state the run creates, while `SKIP` stays for absent external prerequisites. A gap found while creating the skill is fixed in Launch; on a later run, the next `maintain-verification` pass triages it as a harness gap and fixes Launch's seed steps or, when the seed cannot provide it, writes the `Gotchas` entry, so no task edits the map mid-task. |
| A proof run on a stand-in for the real target lists every setup step the stand-in did that the target will not; those stay unverified | Taken | Added to the proof step and to the reply's proof-run item. |

The same change adds a local Dev loop section to `create-verification` (`test`, `--repeat N`, and a Doctor toolchain comparison with CI), which has no upstream counterpart. Every verify skill generated before it is not migrated here; as of this change that is agent-kit's `verify-agent-kit`, interview-tutor's `verify-interview-tutor`, bootstrap's `verify-bootstrap`, and icloud-photos-cli's `verify-icp`. Each adopts the levers at its next `maintain-verification` pass, through local clauses with no upstream counterpart, so that skill's provenance row stays at 11713c6: step 1 checks the control CLI for every subcommand and lever `create-verification` step 2 requires and triages a missing one as a harness gap; the harness-gap triage keeps an added or changed lever only after `create-verification` step 4's step 9 checks pass, and fixes a missing seed precondition in Launch's seed steps or, when the seed cannot provide it, in the feature's `Gotchas`.

## 2026-10-14: catch-up adopted from ketchup at 5108b71

Upstream: `pstack/skills/ketchup`, added in 978ca6e (#539) and changed in `11713c6..5108b71` by ea32d95 (`show /ketchup decisions as before/after visuals`, #570), d00ba6e (`shorten /ketchup replies and build them on real visuals`, #595), and c86f349 (`make /ketchup read like /bro in 150 words`, #609). The 2026-10-11 resync did not adopt it. agent-kit #44 adopts it because thread audits showed the user asking "is anything running?" and "what pr is waiting" across threads, which neither the "Needs you" opening nor `show-me-your-work` answers.

| Upstream text | Decision | Reason |
| --- | --- | --- |
| Catch up since the user's last message in this chat; notifications and subagent results are not their messages | Changed | Each thread's window starts at the user's last message in that thread, since the user's last message in the catch-up conversation says nothing about what they saw elsewhere. Threads still working, waiting on the user, or ended `failed` or `interrupted` are reported whatever the window. The rule on what counts as the user's message is kept. |
| Plain words, short sentences, no hashes or paths unless needed to act, names the user knows | Taken | Kept without `/bro`, which agent-kit does not have. |
| Read-only turn; check the current state of each PR, CI run, or agent | Taken | Extended: the current state is read from the forge, thread and PR text is treated as untrusted, and helper threads are never read, since reading a direct child's final result acknowledges its completion. |
| Action items: only what the user can do, including ones raised earlier; never invent one | Taken | Extended with countersigns, landing, open thread questions, and permission prompts, and each item names the thread where the answer counts. |
| A step the user did not ask for and the work does not need is not an action item unless it is irreversible and waits on the user; it gets one line and no "what happens if" line | Taken | |
| Under 150 words, open with how many things need the user, cut history before action items | Taken | |
| Action item as recommendation plus what happens if the user does not answer | Taken | |
| Scope is one chat | Changed | Where the thread tools exist, the scope is the user's top-level threads in the project that are not settled, and their linked PRs; elsewhere it is this conversation, and the reply says so. |
| `disable-model-invocation: true` | Rejected | The skill is read-only and should load when the user asks "catch me up" or "what's waiting on me" in their own words. A catch-up on one unattended run's decision log stays with `show-me-your-work`. |
| A visual of at most four boxes, before-and-after visuals for every action item, screenshots, Mermaid, `/visualize` | Rejected | The reply is a few plain sentences; agent-kit draws only on an explicit request (`show-me`). |
