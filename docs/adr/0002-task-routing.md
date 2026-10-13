# ADR 0002: Route every task prompt through Jev

- **Status:** accepted, 2026-10-12. Amends ADR 0001 decision 5 for task prompts.
- **Scope:** the task-route policy in `agentic/tools/jev/route.ts`, the Claude Code and Codex `UserPromptSubmit` hooks, and the Pi extension `pi/extensions/task-class.ts`. The design is `docs/design/jev-task-routing.md`.

## Context

ADR 0001 decision 5 let Jev see task prompts only from public repositories, and let it only add caution: a one-way-door hint. The user picks the level of work by naming modes such as `background-run`. The user wants Jev to pick the level instead (answer a lookup directly, apply the full method, or hand off a long run), and wants every prompt in every runtime and on every machine tracked, so the choice can be measured before it acts.

## Constraints

- TypeSafe's privacy policy says it does not train on input. It states no retention period.
- Pi reaches TypeSafe through its classifier registry, which accepts only an object state and reports the requested model (`jev-latest`), not the version that answered.
- The door hint's threshold holds only for its exact question wording. Rechecked on 2026-10-12 with both questions in one request and a `{ task }` state, it matched the 2026-10-07 baseline.

## Decision

1. **Which prompts are sent.** A prompt from any repository is sent to TypeSafe unless the repository commits `.agents/jev-opt-out`, or the session sets `AGENTIC_ROUTE=off`. Prompts typed outside a repository are sent. A prompt is withheld when it has fewer than 6 words or more than 4,000 characters, contains a common credential format, or comes from a child session. Home directories are redacted. Nothing else is sent: not the working directory, the repository name, earlier turns, or files. The PR-risk check in `ship` still sends diffs only from public repositories.
2. **Notes that reduce caution.** There are two: lookup ("answer directly") and loop ("read `background-run` and follow it"). A note acts only once its policy entry carries a `Calibration`: precision and recall measured on the exact question wording (checked by digest) and on the answering model. It is added in a reviewed commit and meets the acting bars set on 2026-10-12. For lookup, precision is at least 0.95 and no one-way-door sample is routed to lookup. For loop, precision is at least 0.9 on at least 10 labeled positives, and Jev beats a local handoff word list. Until then both are recorded in shadow and never delivered. A note calibrated on one model drops back to shadow when another model answers. The door hint keeps its question and threshold, and since 2026-10-12 it is in shadow too (see Consequences). A slash command is the user's own choice and gets no note. Landing modes stay reachable only through the user's own words.
3. **Every prompt is recorded.** Claude Code, Codex, and Pi each append one record per prompt to `$XDG_STATE_HOME/agentic/task-route/<machine>/<runtime>-<session>.jsonl`, including withheld and failed prompts. A record holds Jev's answers, routes, counts, and a digest, never the prompt's text. The ledger is an evaluation instrument, not a contract.

## Alternatives

- **Keep public repositories only.** Most of the user's work happens in private repositories, so routing and its measurement would miss most of it.
- **Opt in per repository.** The user chose opt-out, so routing covers work by default.
- **Make `background-run` model-invocable instead of routing loops through Jev.** It sends nothing, but lets the model start unattended runs on unmeasured judgment. The user kept it manual. It remains the fallback if Jev's loop note fails its bar.

## Consequences

- Task text from private repositories reaches TypeSafe. Opting out is manual, per repository.
- Notes are per prompt, not per task. The model resolves them with the conversation.
- Under Pi, model drift cannot be detected, so Pi's lookup and loop notes stay in shadow until Pi reports the answering version. The door hint is unaffected.
- A T3-delegated child session cannot yet be told apart from a typed prompt in the Claude and Codex hooks, so its brief is classified like a prompt, as the door hint already was.
- Each prompt adds one record of under 1 KiB to the local ledger.
- Since 2026-10-12 the door hint is in shadow too. On live prompts, mostly short follow-ups that Jev sees without their conversation, it fired on nearly every reversible prompt, so it waits for `route-eval` on labeled live records. Turns the runtime starts itself (Claude Code task notifications, T3 wake-ups after a delegated task) are recorded with the fallback `system` and never sent, in all three runtimes.

## Reversal conditions

Revisit this if TypeSafe's data policy changes, or if lookup or loop fails its acting bar after the shadow period. Restoring the public-only gate means making `screen` in `agentic/tools/jev/egress.ts` withhold every repository that is not public. `AGENTIC_ROUTE=off` stops routing for a session at once.
