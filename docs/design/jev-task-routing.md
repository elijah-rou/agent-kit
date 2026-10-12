# Jev task routing

- **Status:** proposed 2026-10-12. All open questions were decided on 2026-10-12, Pi's transport was changed to its classifier registry, and every prompt in every runtime on every machine is now recorded (see Tracking across everything). Nothing is built.
- **Reader:** the user reviewing the shape, then whoever implements it.
- **Door:** this design changes ADR 0001 decision 5 ("Jev is advisory and only adds caution"), the rule for which task text leaves the machine, and a policy that every runtime shares. The question wording, thresholds, note text, and adapters around those are reversible. So is the record format: the ledger is a temporary evaluation instrument, not a contract, and a format change may drop old records.

## Problem

Today the user picks the level of work by typing skill names, such as `background-run`. Jev adds only a one-way-door hint (`agentic/tools/jev/jev.ts`, delivered by the Claude Code `UserPromptSubmit` hook and `pi/extensions/task-class.ts`). The goal is for Jev to pick the level for each task, so the user stops naming modes:

- **lookup:** answer directly.
- **rigor:** the full engineering method, the equivalent of pstack's `/poteto-mode`.
- **loop:** a long or unattended run to a done predicate.

The door dimension stays as it is.

Two facts shape everything below.

1. **Rigor is already the floor.** `claude/CLAUDE.md` and `pi/AGENTS.md` carry the full method and scale it. Routing to rigor therefore changes nothing, and neither does any failure. Only two notes leave the floor: lookup and loop.
2. **One policy, two transports.** The Claude hook calls TypeSafe over HTTP. Pi calls Jev through its own classifier registry, where the user enables TypeSafe Jev and Pi owns the credential. The policy, questions, and egress rules are shared; only the request path differs.

## Usage

The user types tasks as now, in Claude Code, Codex, or Pi, in any repository the user has not opted out.

- "Going to bed, keep fixing the flaky session tests until CI is green twice in a row." The agent gets a loop note, reads `background-run`, writes the framing, and runs.
- "Where does the config loader read XDG paths?" Once calibrated, the agent gets a lookup note and answers directly.
- "Migrate the ledger store from JSON files to SQLite." No level note, so this is rigor. The door note fires as today.
- `/background-run …` or any other slash command is the user's own choice, so no note is delivered. The text is still classified in shadow and recorded, so each manual invocation becomes a labeled example.
- `AGENTIC_ROUTE=shadow` or `AGENTIC_ROUTE=off` lowers every note for a session. `off` also stops every call to TypeSafe. Nothing local can raise a note.

The Claude Code hook keeps its command, and Codex's `UserPromptSubmit` hook, which receives the same fields, runs `task-class --codex-hook`. Only the internals change:

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
    { classify: registryClassifier(ctx.modelRegistry), env: process.env, now: Date.now, signal: ctx.signal },
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

1. `egress`: task-sized, not a child, repository not opted out, credential screen, length bound, home paths redacted. A slash command's text continues in shadow only. The result is `Sendable`.
2. One HTTP request carrying two questions, returning `Answers`.
3. `decide` (pure): the answers and thresholds give an advised route.
4. `applyModes` (pure): drops any note that isn't in advisory mode.
5. `noteFor` (pure): fills a fixed template.
6. Append one record.
7. The adapter delivers the note.

### What Jev is asked

Each prompt gets one request with state `{ task }`, which meets the door bar (see the door recheck below). The Claude hook posts it to `https://api.typesafe.ai/v1/systemone` with the keychain or environment key. Pi sends it through its classifier registry (`ctx.modelRegistry.findOfType("classifier")` and `classify`), with the TypeSafe credential Pi holds. Both questions are `choice` questions, which both paths support. A Pi with no TypeSafe classifier registered takes the `classifier-unavailable` fallback rather than reading the keychain. Because two request paths can wrap the state differently, the eval runs the labeled set through both and requires matching answers before either note goes advisory.

| Id | Type | Wording |
| --- | --- | --- |
| `door` | choice | `TASK_INSTRUCTIONS` and `TASK_CRITERIA` from `jev.ts`, verbatim |
| `level` | choice | "The state is a message a user sent to a coding agent. Classify how much process the agent should apply." `lookup`: a question or small request answerable directly from reading code, docs, or state, with no change beyond a trivial edit. `rigor`: a change, fix, investigation, or design that needs grounding, verification, and review. `loop`: the user's own words hand the work off to run without them, or to keep going until a stated condition holds. Length alone does not make a loop. |

**Probe evidence.** These numbers come from synthetic tasks only, against `jev-1.13.0` on 2026-10-12, so they indicate rather than calibrate.

- The `level` choice classified 10 of 10 invented tasks correctly, mostly at confidence 0.97 to 1.00.
- A yes/no ("noul") `quick` question, candidate B's alternative, scored clear lookups at only 0.28 to 0.67.
- A noul `handoff` question separated loops (0.95 to 0.97) from rigor (0.57 to 0.71).
- Two or three questions in one request took 340 to 420 ms.

**Door recheck.** On 2026-10-12 the 90 labeled 2026-10-07 tasks were each asked four times with both questions in one request, against `jev-1.13.0`:

| Request | One-way-door calls hinted | Tasks missed | Other calls hinted |
| --- | --- | --- | --- |
| 2026-10-07 baseline: door question alone, string state, 2 repeats | 56 of 60 | T046, T089 | 16 of 120 |
| both questions, string state, 4 repeats | 112 of 120 | T046, T089 | 31 of 240 |
| both questions, `{ task }` state, 4 repeats | 112 of 120 | T046, T089 | 32 of 240 |

Both shapes meet the door bar. The state is `{ task }`, because Pi's classifier registry accepts only an object, so both runtimes send the same request. A first pair of repeats showed 15 against 17 other calls hinted; the next pair reversed it, so that gap was noise. Repeats of one request flip about 1 hint in 90.

With the provisional 0.9 threshold, no one-way-door task was advised lookup, and none of the 90 was advised loop. Two trivial edits were advised lookup: a `.gitignore` line and a README clarification. The closest miss was T046, the MIT license, which the door question also misses: its lookup confidence reached 0.85, so the lookup threshold must stay above that. Two questions took 389 ms at p50 and 507 ms at p95.

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
| Codex | hook `additionalContext`, the same mechanism as Claude | same | same | nothing |

Jev never points at `babysit-and-ship`, `correct`, `reflect`, or the verification-authoring skills. `background-run` stays `disable-model-invocation: true`. That flag is a cost gate, and a calibrated loop note is the measured exception to it. Landing modes are an authority boundary, so they stay reachable only through the user's own words.

### What may leave the machine

The only thing sent is the user's prompt for one turn, and only when all of these hold:

- the prompt has at least 6 words and at most 4,000 characters (longer prompts are withheld, because pasted logs hide secrets);
- it contains no credential shape, using the list as of PR #16;
- a slash command is sent without its command name and gets a shadow answer only;
- the session isn't a child;
- the working directory's repository is not opted out. A repository opts out when the user commits an `.agents/jev-opt-out` file, and `AGENTIC_ROUTE=off` opts out a whole session. Prompts typed outside any repository are sent.

Home paths become `~`. Nothing else is sent: not the cwd, the repository name, earlier turns, files, or tool output. On 2026-10-12 the user widened ADR 0001's rule from public repositories to every repository not opted out, and ADR 0002 records that. The PR-risk check in ship still sends diffs from public repositories only. `egress.ts` is the only module that produces `Sendable`, and the transport accepts nothing else.

### Failure

Every failure delivers nothing beyond what the door rule allows, writes one record, and never blocks the prompt.

| Condition | Fallback | Request sent |
| --- | --- | --- |
| under 6 words, or a child session | `not-a-task`, `child` | no |
| a slash command | `explicit-choice`: a shadow answer is recorded, and no note is delivered | yes |
| an opted-out repository, a credential shape, or over 4,000 characters | `opted-out`, `unsafe-input` | no |
| no key, the 3 s deadline passes, a cancel, or an HTTP or parse error | `classifier-unavailable`, `timeout`, `cancelled`, `error`, `malformed` | maybe |
| a loop is advised but the skill file is missing | `skill-missing` (falls back to rigor) | yes |
| the answering model differs from the one the threshold was calibrated on | `model-drift`: lookup and loop drop to shadow, while door stays, since it only adds caution | yes |

### Measured before it acts

- **Modes per note.** `door` is advisory (today's behavior). `lookup` and `loop` start in shadow, which records what they would have done.
- **A note can't act without evidence.** Advisory mode requires a `Calibration`. It holds the threshold, the model, sample and positive counts, precision, recall, the date, and a digest of the exact question wording. A test fails when the wording changes and the digest no longer matches, which turns `jev.ts`'s comment "changing either wording means recalibrating" into a check. Flipping a note to advisory is a reviewed commit that adds its `Calibration`.
- **Records hold answers, not text.** Each session appends to `$XDG_STATE_HOME/agentic/task-route/<machine>/<runtime>-<session>.jsonl`, one line of under 1 KiB per prompt. A line holds the raw answers (choice, confidence, probabilities, model), the advised and delivered routes, modes, fallback, latency, word and character counts, and a 16-hex digest of the prompt. It never holds task text. Each file has one writer, and the reader merges files and dedupes. Because `decide` is pure, a new threshold can be replayed over stored answers without new requests.
- **Labels come from the user's own history.**
  - `route-harvest` joins records to local Claude, Codex, and Pi transcripts by digest. It writes candidates to an ignored local file and skips opted-out repositories. Text stays on the machine whose agent received it. The user's labels are stored by digest, without text, in that machine's ledger directory, so they travel with its records.
  - Sessions where the user typed `/background-run` supply loop positives.
  - The user labels 150 to 200 prompts, about an hour.
  - The 2026-10-07 door samples are committed in `elijah-rou/agentic` (`evals/jev-risk`: 90 hand-labeled tasks, each asked twice, answered by `jev-1.13.0`), so the door bar is rechecked on them directly. Only lookup and loop need new labels.
- **Acting bars.** These are proposals and the user's decision:
  - **door:** with the combined request, no worse than the 2026-10-07 baseline on the same samples: 4 of 60 door calls missed (2 of 30 tasks) and 16 of 120 other calls hinted.
  - **lookup:** precision of at least 0.95, and no door-labeled sample routed to lookup.
  - **loop:** precision of at least 0.9 on at least 10 labeled positives, and it must beat a local handoff word list ("going to bed", "keep going until", "overnight", "until green"). If Jev doesn't beat the list, the list routes loops and sends nothing.

### Tracking across everything

The two-week review of `background-run` (open question 3) only means something if the ledger sees every prompt the user types, in every runtime, and shows its own gaps.

**One ledger, every entry point.**

| Entry point | Writer | Notes |
| --- | --- | --- |
| Claude Code, direct or launched by T3 | the `UserPromptSubmit` hook | T3-launched sessions carry `T3CODE_CLI_PATH`, recorded as launcher `t3` |
| Codex, direct or launched by T3 | the `UserPromptSubmit` hook (Codex 0.162, stable `hooks` feature) | Codex asks the user to review a non-managed hook once with `/hooks`. Whether it fires under T3 is unverified, and the coverage report shows it. |
| Pi: terminal, RPC, and T3 roots | the `task-class` extension | |
| Children (native Pi children, T3 delegated tasks) | none | they act on a brief, not a user prompt |
| Hermes jobs (later) | the T3 dispatcher, from the job's route field | not built |

**Every prompt writes a record**, including short follow-ups, slash commands, opted-out repositories, and failures. The ledger therefore counts what was not routed and why, not only what was. A slash command is the user's own choice, so no note is delivered. Its remaining text is still classified in shadow, so every manual `/background-run` becomes a labeled loop example together with what Jev would have advised.

**Records gain where they came from:**

- `runtime`: `claude`, `codex`, or `pi`;
- `launcher`: `t3` or `direct`;
- `machine`: the short host name of the machine the agent runs on, such as `bananamac`;
- `repo`: `owner/name`, or `none` outside a repository;
- `optedOut`;
- `explicit`: the command name, when one was typed.

They still never hold task text.

**Layout.** Files live at `$XDG_STATE_HOME/agentic/task-route/<machine>/<runtime>-<session>.jsonl`. Each file has one writer, so ledgers from several machines combine by copying directories into one place, with no merge.

**The coverage report makes gaps visible.**

- `agentic jev route-report` reads the ledger and the local transcripts of all three runtimes (`~/.claude/projects`, `~/.codex/sessions`, and Pi's session directory). For each runtime, launcher, and machine it reports:
  - prompts found in transcripts;
  - prompts with a record;
  - fallback reasons;
  - manual `background-run` invocations, with what Jev advised for each;
  - the lookup and loop notes that shadow mode would have delivered.
- Coverage under 100% for a runtime means a broken writer, not missing data, and the report says which.
- Codex documents its transcript format as unstable, so its transcript reader is covered by a fixture test.

**Machines.** Agents run on two machines, so each machine holds only part of the data. Today that is `bananamac`. Later, `bananaarch` is added: an always-on Linux machine that will run most of the work with this same setup. `bananamac` will drive T3 threads on it over Tailscale and still run threads of its own. A record names the machine the agent runs on, so a T3 thread typed on `bananamac` but running on `bananaarch` counts as `bananaarch`.

- Coverage needs transcripts, which hold text, so each machine checks its own. `route-report` writes that machine's result, as counts without text, to `coverage.json` in its own ledger directory.
- `agentic jev route-sync <host>` copies this machine's ledger directory, including `coverage.json` and its labels, to the same path on `<host>` over SSH. Only the machine's own directory is copied, and it has one writer, so a copy never conflicts. Nothing goes to a third party.
- `bananaarch` is always on, so it is the collection point. `route-report` there covers every machine directory it holds and names each copied machine with its last sync time, so stale data shows as stale instead of disappearing.
- Setting up `bananaarch` needs the TypeSafe key on Linux. `apiKey` reads only `TYPESAFE_API_KEY` and the macOS keychain, so a Linux store is chosen when that machine is set up. Pi there uses its own registry credential.

### Module map

The main flow is three files deep: the adapter, then `route.ts`, then `egress.ts`.

| Path | Owns | Change |
| --- | --- | --- |
| `agentic/tools/jev/egress.ts` | Everything that leaves the machine: screen, redaction, length bound, `isPublic`, `originSlug`, `apiKey`, and `httpClassifier`. Only it produces `Sendable`, and both transports accept only `Sendable`. | split from `jev.ts` |
| `agentic/tools/jev/route.ts` | Policy `task-route@1`: `QUESTIONS`, `POLICY`, `decide`, `applyModes`, `noteFor`, `routeTask`, `RouteRecord` | new |
| `agentic/tools/jev/route-eval.ts` | `harvest`, `score`, and a report without text | new |
| `agentic/tools/jev/pr-risk.ts` | the PR-risk question, threshold, and state | the rest of `jev.ts` |
| `agentic/tools/jev/cli.ts` | `task-class --claude-hook` (unchanged command), `task-class --codex-hook`, `pr-risk`, `route-harvest`, `route-eval`, `route-report`, `route-sync` | edited |
| `pi/extensions/task-class.ts` | the Pi adapter above, including `registryClassifier`, which parses Pi's `ClassifierAnswer` into the shared answer shape | rewritten in place |
| `docs/adr/0002-task-routing.md` | amends ADR 0001 decision 5 | new |

`taskClass`, `taskHint`, and `taskHintFor` are deleted in the same change that migrates their callers and tests. `pi-t3-runtime` is out of scope for now and needs no routing code.

### Children and Hermes

Children are never classified. The parent writes `Route: <level>; door: <yes|no>` into the brief, and the brief checklist in the instructions gains that line. A future Hermes job fills the same field. In types, `Explicit` gains a `{ source: "delegator"; level }` variant, which `routeTask` delivers without asking Jev. Nothing is built for Hermes now (see `hermes-outer-loop.md`).

## Types and signatures

```ts
type Sendable = Brand<string, "Sendable">;          // only egress.ts produces it
type Level = "lookup" | "rigor" | "loop";
type DoorClass = "reversible" | "experiment" | "one-way-door";
type Explicit = { source: "slash-command"; command: string };   // later: { source: "delegator"; level: Level }

type Egress = { kind: "send"; text: Sendable } | { kind: "withhold"; reason: "not-a-task" | "child" | "opted-out" | "unsafe-input" } | { kind: "shadow-only"; text: Sendable; explicit: string };
function egress(input: { prompt: string; cwd: string; child: boolean; explicit?: Explicit }, deps: { env: Env; deadlineAt: number; now: () => number }): Promise<Egress>;

type ClassifyOutcome = { kind: "answered"; answers: Record<string, ChoiceAnswer>; model: string } | { kind: "failed"; reason: "classifier-unavailable" | "timeout" | "cancelled" | "error" | "malformed" };
type Classify = (state: { task: Sendable }, questions: typeof QUESTIONS, signal: AbortSignal) => Promise<ClassifyOutcome>;
function httpClassifier(key: (env: Env, timeoutMs: number) => Promise<string | undefined>): Classify;   // Claude hook
function registryClassifier(registry: PiModelRegistry): Classify;                                        // Pi; unavailable without a TypeSafe classifier

type ChoiceAnswer<C> = { choice: C; confidence: number };
type Answers = { door: ChoiceAnswer<DoorClass>; level: ChoiceAnswer<Level>; model: string };   // the record also keeps each answer's probabilities
type DoorNote = { choice: DoorClass; confidence: number };
type Route = { level: "lookup" } | { level: "rigor"; door?: DoorNote } | { level: "loop"; door?: DoorNote };   // lookup has no door

type Calibration = { threshold: number; questionsDigest: string; model: string; samples: number; positives: number; precision: number; recall: number; date: string; source: string };
type NotePolicy = { mode: "shadow"; threshold: number } | { mode: "advisory"; calibration: Calibration };   // a shadow threshold is provisional
type Policy = { id: "task-route"; version: number; deadlineMs: number; notes: Record<"door" | "lookup" | "loop", NotePolicy> };
type Session = "policy" | "shadow" | "off";   // from AGENTIC_ROUTE; any value other than off lowers to shadow

function decide(answers: Answers, policy: Policy): { advised: Route; fallback?: "conflict" | "low-confidence" };
function applyModes(advised: Route, policy: Policy, session: Session, model: string): { delivered: Route; fallback?: "model-drift" };
function noteFor(delivered: Route, backgroundRunSkill: string): string | undefined;   // routeTask records skill-missing before calling it
function routeTask(input: RouteInput, deps: RouteDeps): Promise<{ note?: string; record: RouteRecord }>;
function digestQuestion(question: (typeof QUESTIONS)["door" | "level"]): string;   // each note's calibration names its own question's digest
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

**From the user:** Pi calls Jev through its classifier registry, and the Claude hook calls the HTTP API directly. An earlier draft used HTTP in both.

**Rejected:**
- A's injected rigor method and shared loop method file: the floor already carries the method.
- A's per-actor task slots: too much machinery for a per-prompt note.
- C's plan to make `background-run` model-invocable: kept as an open question instead.

## Tradeoffs accepted

- We accept sending prompts from every repository not opted out, private ones included, in exchange for routing and measurement everywhere. Opting out is manual and per repository. TypeSafe's privacy policy says it does not train on input; it states no retention period.
- We accept two caution-reducing exceptions to "Jev only adds caution": lookup, and loop loading a manual skill. In exchange, the user stops naming modes. Both need calibration and an ADR amendment.
- We accept notes per prompt rather than per task, in exchange for no task-boundary state. Notes are conditional, and the model resolves them with conversation context.
- We accept that rigor injects nothing. In exchange, failures and rigor behave identically to today and cost no tokens.

## Alternatives considered

- **A single four-way question (lookup, rigor, loop, door).** It loses the calibrated door question and can't express "a loop that is also a door".
- **Jev choosing the skill directly.** It needs recalibration on every skill edit, and invites Jev into choosing manual or authority-bearing skills.
- **Making `background-run` model-invocable, with no Jev for loops.** This sends nothing, but it lets the model start unattended runs on unmeasured judgment. The user kept it manual (open question 3). It is the fallback if Jev's loop precision fails its bar.
- **Sharing one engine extracted from `pi-t3-runtime`.** That repository is out of scope for now, and sharing `egress.ts` gives one source of truth for the real invariant.

## Open questions

These are for the user. Each has a recommendation and the default taken if there's no answer.

1. **Amend ADR 0001 decision 5 to allow the lookup and loop notes?** Decided: yes, scoped to calibrated notes. ADR 0002 records it in slice 2.
2. **Private repositories.** Decided: send their prompts too, with a manual per-repository opt-out (`.agents/jev-opt-out`).
3. **`background-run`:** keep it manual and reached through the loop note, or make it model-invocable? Decided: keep it manual. It is revisited after two weeks with `route-report`, which only works because every runtime records (see Tracking across everything).
4. **The acting bars** above. Decided: as written.
5. **Labeling time:** about an hour for 150 to 200 harvested prompts, after about two weeks of shadow records. Decided: yes.
6. **Machines.** Decided: agents will run on both `bananamac` and `bananaarch`. Each machine checks its own coverage, and `route-sync` copies its directory to `bananaarch` over SSH, not to a repository (see Machines under Tracking across everything).

## First implementation step

Slice 1 is offline and changes no live behavior. Split `jev.ts` into `egress.ts` and `pr-risk.ts`, moving the tests unchanged. Then write `route.ts`'s pure core with tests for the decision table, the runtime-neutral note text, and "advisory requires a matching digest". Slice 2 switches the Claude, Codex, and Pi adapters to `routeTask` and starts the ledger, with `lookup` and `loop` in shadow. The door bar on the combined request was rechecked on 2026-10-12 and passes with `{ task }`. Slice 3 adds `route-report` and `route-sync`. `route-harvest` and `route-eval` follow once two weeks of records exist.
