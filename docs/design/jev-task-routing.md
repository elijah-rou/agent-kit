# Jev task routing

- **Status:** proposed 2026-10-12. Under review by the user; nothing is built.
- **Reader:** the user reviewing the shape, then whoever implements it.
- **Door:** this design changes ADR 0001 decision 5 ("Jev is advisory and only adds caution"), the rule for which task text leaves the machine, and a policy and decision-record format that both runtimes share. The question wording, thresholds, note text, and adapters around those are reversible.

## Problem

Today the user picks the level of work by typing skill names, such as `background-run`. Jev adds only a one-way-door hint (`agentic/tools/jev/jev.ts`, delivered by the Claude Code `UserPromptSubmit` hook and `pi/extensions/task-class.ts`). The goal is for Jev to pick the level for each task, so the user stops naming modes:

- **lookup:** answer directly.
- **rigor:** the full engineering method, the equivalent of pstack's `/poteto-mode`.
- **loop:** a long or unattended run to a done predicate.

The door dimension stays as it is.

Two facts shape everything below.

1. **Rigor is already the floor.** `claude/CLAUDE.md` and `pi/AGENTS.md` carry the full method and scale it. Routing to rigor therefore changes nothing, and neither does any failure. Only two notes leave the floor: lookup and loop.
2. **Two Jev clients have already drifted.** `pi-t3-runtime/src/jev.ts` copied agent-kit's credential screen. The copy lacks the `apikey_` fix (PR #16) and has no public-repository rule.

## Usage

The user types tasks as now, in a checkout of a public GitHub repository.

- "Going to bed, keep fixing the flaky session tests until CI is green twice in a row." The agent gets a loop note, reads `background-run`, writes the framing, and runs.
- "Where does the config loader read XDG paths?" Once calibrated, the agent gets a lookup note and answers directly.
- "Migrate the ledger store from JSON files to SQLite." No level note, so this is rigor. The door note fires as today.
- `/background-run …` or any other slash command is the user's own choice, so Jev is not asked.
- `AGENTIC_ROUTE=shadow` or `AGENTIC_ROUTE=off` lowers every note for a session. `off` also stops every call to TypeSafe. Nothing local can raise a note.

The Claude hook keeps its command; only the internals change:

```ts
const event = parseHookEvent(await Bun.stdin.text());
const { note } = await routeTask(
  { prompt: event.prompt, cwd: event.cwd, session: { runtime: "claude", id: event.sessionId }, child: false, explicit: slashCommand(event.prompt) },
  { classify: httpClassifier(apiKey), env: process.env, now: Date.now },
);
if (note) printAdditionalContext(note);
```

The Pi extension is rewritten in place. It also runs in Pi roots that T3 launches:

```ts
pi.on("before_agent_start", async (event, ctx) => {
  const { note } = await routeTask(
    { prompt: event.prompt, cwd: ctx.cwd, session: { runtime: "pi", id: ctx.sessionManager.getSessionId() }, child: isNativeChild(), explicit: takeSlashCommand() },
    { classify: httpClassifier(apiKey), env: process.env, now: Date.now, signal: ctx.signal },
  );
  return note ? { message: { customType: "agent-kit/task-route", content: note, display: true } } : undefined;
});
```

The user runs measurement locally:

```sh
agentic jev route-harvest --since 2026-07-01   # local transcripts -> $XDG_STATE_HOME/agentic/task-route/candidates.jsonl
agentic jev route-eval labels.jsonl            # per-note precision and recall, door vs baseline, word-list baseline, latency
```

## Shape

### Flow

The whole flow runs once per prompt, in a single pass through these steps:

1. `egress`: task-sized, not a slash command, not a child, public origin, credential screen, length bound, home paths redacted. The result is `Sendable`.
2. One HTTP request carrying two questions, returning `Answers`.
3. `decide` (pure): the answers and thresholds give an advised route.
4. `applyModes` (pure): drops any note that isn't in advisory mode.
5. `noteFor` (pure): fills a fixed template.
6. Append one record.
7. The adapter delivers the note.

### What Jev is asked

There is one request to `https://api.typesafe.ai/v1/systemone`, with state `{ task }`. The same HTTP transport serves both runtimes: Pi does not use its classifier registry. That gives one credential path and one wire format to calibrate.

| Id | Type | Wording |
| --- | --- | --- |
| `door` | choice | `TASK_INSTRUCTIONS` and `TASK_CRITERIA` from `jev.ts`, verbatim |
| `level` | choice | "The state is a message a user sent to a coding agent. Classify how much process the agent should apply." `lookup`: a question or small request answerable directly from reading code, docs, or state, with no change beyond a trivial edit. `rigor`: a change, fix, investigation, or design that needs grounding, verification, and review. `loop`: the user's own words hand the work off to run without them, or to keep going until a stated condition holds. Length alone does not make a loop. |

**Probe evidence.** These numbers come from synthetic tasks only, against `jev-1.13.0` on 2026-10-12, so they indicate rather than calibrate.

- The `level` choice classified 10 of 10 invented tasks correctly, mostly at confidence 0.97 to 1.00.
- A yes/no ("noul") `quick` question, candidate B's alternative, scored clear lookups at only 0.28 to 0.67.
- A noul `handoff` question separated loops (0.95 to 0.97) from rigor (0.57 to 0.71).
- Two or three questions in one request took 340 to 420 ms.
- The HTTP API accepts `choice` and `noul` but rejects `bool`, and every response names its model.

### Decision

`decide` is pure and total. The door rule fires on `one-way-door`, or on any door confidence below 0.8, exactly as today.

| `level` (at or above its threshold) | Door rule | Route | Fallback recorded |
| --- | --- | --- | --- |
| lookup | does not fire | lookup | none |
| lookup | fires | rigor plus the door note | `conflict` |
| loop | any | loop, plus the door note if it fires | none |
| rigor, or below threshold | any | rigor, plus the door note if it fires | none, or `low-confidence` |

The `Route` type gives lookup no door field, so "a lookup that might be a door" can't be expressed.

### What each route changes

Notes are fixed templates. No Jev text reaches the model, only a route key and numbers. Each note says that the user's words and the instructions take precedence.

| Runtime | Delivery | lookup | loop | rigor or any failure |
| --- | --- | --- | --- | --- |
| Claude Code | hook `additionalContext` | "Answer directly: no plan, subagents, or headings. If it turns out to need a change, treat it as a task." | "If the user's words hand the work off, read `background-run`'s SKILL.md at <path> and follow it. This invokes no landing mode." | nothing (the door note fires as today) |
| Pi, and Pi roots under T3 | a custom message from `before_agent_start`, persisted and visible. Its pointer survives short follow-ups, and the system prompt stays byte-stable for the provider cache. | same | same | nothing |
| Pi and T3 children | none: children work from their brief, whose `Route:` line the parent fills | – | – | – |
| Codex | none (no hook), so the floor alone | – | – | – |

Jev never points at `babysit-and-ship`, `correct`, `reflect`, or the verification-authoring skills. `background-run` stays `disable-model-invocation: true`. That flag is a cost gate, and a calibrated loop note is the measured exception to it. Landing modes are an authority boundary, so they stay reachable only through the user's own words.

### What may leave the machine

The only thing sent is the user's prompt for one turn, and only when all of these hold:

- the prompt has at least 6 words and at most 4,000 characters (longer prompts are withheld, because pasted logs hide secrets);
- it contains no credential shape, using the list as of PR #16;
- it isn't a slash command;
- the session isn't a child;
- the GitHub origin of the working directory is public. Unknown counts as private, and the answer is cached for a day, as today.

Home paths become `~`. Nothing else is sent: not the cwd, the repository name, earlier turns, files, or tool output. This is the class of egress ADR 0001 already accepts, so routing adds questions, not text. `egress.ts` is the only module that produces `Sendable`, and the transport accepts nothing else.

### Failure

Every failure delivers nothing beyond what the door rule allows, writes one record, and never blocks the prompt.

| Condition | Fallback | Request sent |
| --- | --- | --- |
| under 6 words, a slash command, or a child | `not-a-task`, `explicit-choice`, `child` | no |
| private or unknown origin, a credential shape, or over 4,000 characters | `private-repo`, `unsafe-input` | no |
| no key, the 3 s deadline passes, a cancel, or an HTTP or parse error | `classifier-unavailable`, `timeout`, `cancelled`, `error`, `malformed` | maybe |
| a loop is advised but the skill file is missing | `skill-missing` (falls back to rigor) | yes |
| the answering model differs from the one the threshold was calibrated on | `model-drift`: lookup and loop drop to shadow, while door stays, since it only adds caution | yes |

### Measured before it acts

- **Modes per note.** `door` is advisory (today's behavior). `lookup` and `loop` start in shadow, which records what they would have done.
- **A note can't act without evidence.** Advisory mode requires a `Calibration`. It holds the threshold, the model, sample and positive counts, precision, recall, the date, and a digest of the exact question wording. A test fails when the wording changes and the digest no longer matches, which turns `jev.ts`'s comment "changing either wording means recalibrating" into a check. Flipping a note to advisory is a reviewed commit that adds its `Calibration`.
- **Records hold answers, not text.** Each session appends to `$XDG_STATE_HOME/agentic/task-route/<runtime>-<session>.jsonl`, one line of under 1 KiB per prompt. A line holds the raw answers (choice, confidence, probabilities, model), the advised and delivered routes, modes, fallback, latency, word and character counts, and a 16-hex digest of the prompt. It never holds task text. Each file has one writer, and the reader merges files and dedupes. Because `decide` is pure, a new threshold can be replayed over stored answers without new requests.
- **Labels come from the user's own history.**
  - `route-harvest` joins records to local Claude and Pi transcripts by digest. It writes candidates to an ignored local file, and only from public repositories.
  - Sessions where the user typed `/background-run` supply loop positives.
  - The user labels 150 to 200 prompts, about an hour.
  - The 2026-10-07 calibration samples were never committed, so this rebuilds them.
- **Acting bars.** These are proposals and the user's decision:
  - **door:** with the combined request, no worse than the 2026-10-07 baseline on the same samples (at most 2 of 30 doors missed, at most 1 in 8 others hinted).
  - **lookup:** precision of at least 0.95, and no door-labeled sample routed to lookup.
  - **loop:** precision of at least 0.9 on at least 10 labeled positives, and it must beat a local handoff word list ("going to bed", "keep going until", "overnight", "until green"). If Jev doesn't beat the list, the list routes loops and sends nothing.

### Module map

The main flow is three files deep: the adapter, then `route.ts`, then `egress.ts`.

| Path | Owns | Change |
| --- | --- | --- |
| `agentic/tools/jev/egress.ts` | Everything that leaves the machine: screen, redaction, length bound, `isPublic`, `originSlug`, `apiKey`, and `httpClassifier`. Only it produces `Sendable`. | split from `jev.ts` |
| `agentic/tools/jev/route.ts` | Policy `task-route@1`: `QUESTIONS`, `POLICY`, `decide`, `applyModes`, `noteFor`, `routeTask`, `RouteRecord` | new |
| `agentic/tools/jev/route-eval.ts` | `harvest`, `score`, and a report without text | new |
| `agentic/tools/jev/pr-risk.ts` | the PR-risk question, threshold, and state | the rest of `jev.ts` |
| `agentic/tools/jev/cli.ts` | `task-class --claude-hook` (unchanged command), `pr-risk`, `route-harvest`, `route-eval` | edited |
| `pi/extensions/task-class.ts` | the Pi adapter above | rewritten in place |
| `docs/adr/0002-task-routing.md` | amends ADR 0001 decision 5 | new |

`taskClass`, `taskHint`, and `taskHintFor` are deleted in the same change that migrates their callers and tests. `pi-t3-runtime` needs no routing code. Its owner should import `egress.ts` before `profile-selection@1` leaves `off`, so the two runtimes share one screen and one public-repository rule.

### Children and Hermes

Children are never classified. The parent writes `Route: <level>; door: <yes|no>` into the brief, and the brief checklist in the instructions gains that line. A future Hermes job fills the same field. In types, `Explicit` gains a `{ source: "delegator"; level }` variant, which `routeTask` delivers without asking Jev. Nothing is built for Hermes now (see `hermes-outer-loop.md`).

## Types and signatures

```ts
type Sendable = Brand<string, "Sendable">;          // only egress.ts produces it
type Level = "lookup" | "rigor" | "loop";
type DoorClass = "reversible" | "experiment" | "one-way-door";
type Explicit = { source: "slash-command" };        // later: { source: "delegator"; level: Level }

type Egress = { kind: "send"; text: Sendable } | { kind: "withhold"; reason: "not-a-task" | "explicit-choice" | "child" | "private-repo" | "unsafe-input" };
function egress(input: { prompt: string; cwd: string; child: boolean; explicit?: Explicit }, deps: { env: Env; deadlineAt: number; now: () => number }): Promise<Egress>;

type ClassifyOutcome = { kind: "answered"; answers: Record<string, ChoiceAnswer>; model: string } | { kind: "failed"; reason: "classifier-unavailable" | "timeout" | "cancelled" | "error" | "malformed" };
function httpClassifier(key: (env: Env, timeoutMs: number) => Promise<string | undefined>): (state: { task: Sendable }, questions: typeof QUESTIONS, signal: AbortSignal) => Promise<ClassifyOutcome>;

type Answers = { door: { choice: DoorClass; confidence: number }; level: { choice: Level; confidence: number; probabilities: Record<Level, number> }; model: string };
type DoorNote = { choice: DoorClass; confidence: number };
type Route = { level: "lookup" } | { level: "rigor"; door?: DoorNote } | { level: "loop"; door?: DoorNote };   // lookup has no door

type Calibration = { threshold: number; questionsDigest: string; model: string; samples: number; positives: number; precision: number; recall: number; date: string };
type NotePolicy = { mode: "off" | "shadow"; calibration?: Calibration } | { mode: "advisory"; calibration: Calibration };
type Policy = { id: "task-route"; version: number; deadlineMs: 3000; notes: Record<"door" | "lookup" | "loop", NotePolicy> };

function decide(answers: Answers, policy: Policy): { advised: Route; fallback?: "conflict" | "low-confidence" };
function applyModes(advised: Route, policy: Policy, env: Env, model: string): { delivered: Route; fallback?: "model-drift" };
function noteFor(delivered: Route, skills: { backgroundRun?: string }): string | undefined;
function routeTask(input: RouteInput, deps: RouteDeps): Promise<{ note?: string; record: RouteRecord }>;
function digestQuestions(questions: typeof QUESTIONS): string;
```

## Synthesis decision

Three candidates were drafted independently on different models:

- **A:** GPT-6.1 Sol on Codex.
- **B:** Claude Opus 5.5.
- **C:** Claude Fable 5.1. The first attempt at C, on Gemini through OpenCode, failed with HTTP 402 (out of credit).

All three converged on the same core:

- one versioned policy in agent-kit;
- one request with today's door question verbatim plus a level question;
- a pure decision step;
- shadow before advisory;
- records without task text;
- an ADR amendment;
- landing modes that stay manual.

**B is the base.** It has the strongest invariants: rigor as the floor with nothing injected, `Sendable` produced in one place, a `Calibration` required for advisory, model-drift demotion, and Pi delivery by custom message.

**From A and C:** the `level` choice question, replacing B's yes/no questions on the probe's evidence.

**From C:**
- the handoff word-list baseline that Jev must beat;
- the `Route:` line in child briefs as the one carrier for explicit levels, which Hermes will also use;
- independent modes for each note.

**From A:**
- `AGENTIC_ROUTE=off` stops all disclosure, not just routing;
- promotion bars fixed before the eval runs.

**From the user:** the Jev HTTP API directly in both runtimes. Pi's classifier registry is not used.

**Rejected:**
- A's injected rigor method and shared loop method file: the floor already carries the method.
- A's per-actor task slots: too much machinery for a per-prompt note.
- C's plan to make `background-run` model-invocable: kept as an open question instead.
- Pi's classifier registry: it would mean two transports to calibrate.

## Tradeoffs accepted

- We accept that private repositories get no routing, in exchange for keeping ADR 0001's rule against disclosure. Records count `private-repo` fallbacks, so the share of work this misses is measured, not guessed.
- We accept two caution-reducing exceptions to "Jev only adds caution": lookup, and loop loading a manual skill. In exchange, the user stops naming modes. Both need calibration and an ADR amendment.
- We accept notes per prompt rather than per task, in exchange for no task-boundary state. Notes are conditional, and the model resolves them with conversation context.
- We accept that rigor injects nothing. In exchange, failures and rigor behave identically to today and cost no tokens.

## Alternatives considered

- **A single four-way question (lookup, rigor, loop, door).** It loses the calibrated door question and can't express "a loop that is also a door".
- **Jev choosing the skill directly.** It needs recalibration on every skill edit, and invites Jev into choosing manual or authority-bearing skills.
- **Making `background-run` model-invocable, with no Jev for loops.** This works in private repositories and Codex with no egress, but it reverses the cost decision. It is the fallback if Jev's loop precision fails its bar.
- **Sharing one engine extracted from `pi-t3-runtime`.** Another session owns that code. Sharing `egress.ts` alone gives one source of truth for the real invariant.

## Open questions

These are for the user. Each has a recommendation and the default taken if there's no answer.

1. **Amend ADR 0001 decision 5 to allow the lookup and loop notes?** Recommendation: yes, scoped to calibrated notes. Default: build in shadow only, with no amendment until a note earns advisory.
2. **Private repositories.**
   - Options: (a) never sent, as today; (b) send their prompts too; (c) (a) plus the handoff word list for loops, which sends nothing.
   - Recommendation: (c). Default: (a).
3. **`background-run`:** keep it manual and reached through the loop note, or make it model-invocable? Recommendation: keep it manual. Default: keep it manual.
4. **The acting bars** above. Recommendation: as written. Default: as written.
5. **Labeling time:** about an hour for 150 to 200 harvested prompts, after about two weeks of shadow records. Default: harvest after two weeks and ask then.

## First implementation step

Slice 1 is offline and changes no live behavior. Split `jev.ts` into `egress.ts` and `pr-risk.ts`, moving the tests unchanged. Then write `route.ts`'s pure core with tests for the decision table, the runtime-neutral note text, and "advisory requires a matching digest". Slice 2 switches both adapters to `routeTask`, with `lookup` and `loop` in shadow, after re-verifying the door bar on the combined request.
