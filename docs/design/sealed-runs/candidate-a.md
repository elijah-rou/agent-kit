# Candidate A: one launcher, `agentic child`, for every child the harness cannot confine

Reviewers stop being in-session subagents. They become headless processes that `agentic child` launches. Each
runs in its own disposable snapshot of the reviewed commit, with an OS sandbox on every shell command, and none
of them can load harness configuration from that snapshot. The overflow implementer is the same launcher with a
second boundary: it writes only its worktree. A Claude Code `PreToolUse` hook on the Agent tool makes the parent
take that route when the quota pace calls for it. The launcher stamps each report with the model the harness
observably ran. When that model differs from the bound one, the lane fails as `substituted`. A lane that cannot
reach its model comes back as `unreachable`.

Facts below come from `/tmp/dc/grounding.md`, the agent-kit worktree at `agent-role-model-rebalance`
(`e27ecd0`), `claude --help` (2.1.302) and `pi --help`. Lines marked **verify** are inferences that the first
slices must confirm.

---

## Problem

agent-kit can launch two things today: native Claude Code subagents, bound in `claude/agents/*.md`, and nothing
else. Two decisions the user has already made need more than that.

1. **Reviewers that can run tests and probes but cannot edit.** `review` and `pr-review` are read-only today
   (`tools: Read, Grep, Glob`). The 2026-10-18 benchmark found that a reviewer able to run the change caught a
   hook-skip bypass a read-only reviewer missed. Giving an in-session subagent `Bash` breaks the boundary,
   because Claude Code's sandbox is per session and a subagent cannot be stricter than its parent (grounding,
   Harnesses). `Bash` can run `sed -i` on the checkout under review. Pi has no sandbox at all. The new
   `adversarial-review` role runs on DeepSeek V4.1 Flash 1017 through Pi, and every pull request gets it and
   `pr-review` in parallel.
2. **An overflow implementer.** Routine `build` work runs on DeepSeek V4.1 Flash (Base tier, thinking `high`)
   through Pi when `agentic quota pace` prints `over` or `exhausted`. Security, verification-policy,
   concurrency, and data-format work always stays on Claude. Pi has no permission prompts and no sandbox, so an
   unattended Pi child holds every permission the user's account holds. That is broader than any session that
   would launch it, which `claude/CLAUDE.md`'s delegation rules forbid.

There are also constraints, and some have teeth:

- Role names are fixed. An unreachable model is reported, never replaced. Children never launch children,
  push, comment, or publish.
- Once a reviewer has a shell, the reviewed snapshot is attacker-controlled input. A pull request can add
  `.claude/settings.json` with a `SessionStart` hook, `.mcp.json`, or `.pi/` extensions. The harness runs those
  itself, outside any shell sandbox, and `claude -p` skips the workspace-trust dialog (`claude --help`, `-p`).
  A design that launches a headless harness with the snapshot as its working directory has to stop that
  configuration from loading.
- A reviewer with a shell can reach `gh`, `git push`, and keychain tokens. The no-publish rule held for free
  while reviewers had no shell. It now needs enforcement.
- T3's `delegate_task` gives children the parent's working directory and no per-child sandbox, and it does not
  exist in a plain terminal (grounding). It cannot carry either boundary.
- LithosAI Ultra returned `429 provider_overloaded` for long stretches, and ten of twelve Flash reviews on Ultra
  died mid-run. Retrying the same binding is a requirement.
- On this machine, `pi --list-models 1017` returns no match. The catalog lists `DeepSeek-V4.1-Flash-0910` and
  the floating `DeepSeek-V4.1-Flash`. `pi auth check --provider lithosai` returns `provider_not_found` (observed
  2026-10-18).

## Usage (caller's view)

### Quickstart

```sh
# In the pull request's worktree, after committing. Run in the background; it returns when both lanes end.
agentic child pr --base origin/main --intent /tmp/intent.md
```

```text
run pr-20261018T171204Z-7f3c  (head 3e1a9c0d21f4, base origin/main, patch 9b20e1c4)
reports in ~/.local/state/agentic/children/agent-kit-5d1e/pr-20261018T171204Z-7f3c/
pr-review           FAIL        claude-opus-5-5                                  pr-review/report.md
adversarial-review  PASS+NOTES  lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017    adversarial-review/report.md
```

Exit status is 0 because both lanes returned a report. A `FAIL` verdict is data, not an error. Each
`report.md` opens with lines the launcher writes, then the reviewer's report:

```text
reviewed by claude-opus-5-5 (pr-review)
run pr-20261018T171204Z-7f3c, head 3e1a9c0d21f4, patch 9b20e1c4
rules: AGENTS.md#standalone, AGENTS.md#runtime-copies, AGENTS.md#stale-description
verdict: FAIL
...
```

### Call site 1: the adversarial pull-request review (`git-workflow`'s `pr-review.md`, step 4)

Step 4 changes from "spawn the `pr-review` role" to one command. The coordinator writes the intent paragraph to
a file. It no longer writes the diff file, picks a reviewer, or passes the procedure's path: the launcher
computes the diff from `base...head`, copies the installed `pr-review.md` into each workspace, and runs every
panel lane.

```sh
# Round 1
agentic child pr --base origin/main --intent /tmp/pr-71-intent.md
# Focused re-review after a fix push: only what the push changed, with the prior round's accepted findings
agentic child pr --base origin/main --since 3e1a9c0d --prior /tmp/pr-71-round1-accepted.md --intent /tmp/pr-71-intent.md
# One lane died on the provider; rerun only that lane on the same head
agentic child pr --base origin/main --intent /tmp/pr-71-intent.md --only adversarial-review
```

When a lane cannot reach its model:

```text
adversarial-review  unreachable  lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017: overloaded (429 provider_overloaded), 3 attempts
```

The exit status is 4. The coordinator writes both lanes into the pull request's `## Review record`:

```text
reviewed by claude-opus-5-5 (pr-review), round 1
reviewed by lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017 (adversarial-review), round 1
- missing-hook-guard: fixed: the pre-push hook ran only when HUSKY was unset
```

An unreachable lane is written as `adversarial-review: unreachable, round 1 (<cause>)`. This is the
"say so rather than claiming an equivalent one happened" rule, made mechanical.

In the autopilot-full and ship modes, the audit lane (`autopilot-full.md` section 3, `shipping.md` section 1)
is this same command, run on the round's head.

### Call site 2: an independent review of a design or a run transcript (`review`)

Used for the design-checkpoint judge, reflect's lenses, the Attention review, and the second audit lane when
`agentic jev pr-risk` prints `high`.

```sh
# Review material outside any repository: the directory is copied, the copy is the workspace
agentic child run review --dir /tmp/dc --brief /tmp/dc/judge-brief.md
# Review against a repository at a commit (the second audit lane: one-way doors only)
agentic child run review --repo . --head 3e1a9c0d --brief /tmp/pr-71-doors-brief.md
```

```text
run review-20261018T172010Z-a01b
review  reported  claude-opus-5-5  review/report.md
```

### Call site 3: routine implementation when the week is ahead of pace (`build`)

The parent launches `build` natively, as today. One field is new in every `build` brief: a `Risk:` line.

```text
Agent(subagent_type: "build", prompt: "Risk: routine\nObjective: add --json to agentic pr-feedback ...")
```

Under pace, or for any risky class, the hook allows the launch and nothing else changes. When `agentic quota
pace` prints `over` or `exhausted` and the brief says `Risk: routine`, the hook denies the native launch and its
reason gives the command:

```text
build is routed to overflow (quota pace: over, risk: routine). The brief is saved at
~/.local/state/agentic/children/briefs/b-4c19e2.md. Run, in the background:
  agentic child run build --worktree <the worktree this brief names> --brief ~/.local/state/agentic/children/briefs/b-4c19e2.md
```

```sh
agentic child run build --worktree ../agent-kit-pr-feedback-json --brief ~/.local/state/agentic/children/briefs/b-4c19e2.md
```

```text
run build-20261018T173300Z-55e0
build  built  lithosai/deepseek-ai/DeepSeek-V4.1-Flash  4 files changed, uncommitted  build/report.md
```

The parent reviews the diff and commits it. An overflow child cannot commit, because the git directory is
outside its sandbox. Other outcomes the parent may see:

```text
build  misrouted    lithosai/...: touched verification policy path scripts/validate; rerun on Claude   build/report.md
build  unavailable  claude week exhausted; Risk: security work stays on Claude                         (no run)
```

`agentic child run build` checks the route again itself. Called while under pace, it launches nothing and exits
3 with `route is claude: launch build natively`.

### Call site 4: proving the boundaries (`doctor`)

```sh
agentic child doctor
```

```text
claude 2.1.302  probe boundary  proven  write outside workspace denied; api.github.com unreachable; Edit/Write absent
pi 0.x          probe boundary  proven  write outside workspace denied; keychain denied; ~/.config/gh unreadable
pi              overflow-build  proven  write to worktree ok; write to git dir denied
lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017   unreachable  not in pi's model catalog
lithosai/deepseek-ai/DeepSeek-V4.1-Flash        reachable
```

The launcher runs `doctor` for a harness by itself the first time it sees that harness at a new version, and
records the proof keyed by version. A Claude Code update therefore cannot quietly weaken the boundary.

## Shape

### The decision in one paragraph

Roles split into two kinds by **who enforces their boundary**. *Native roles* (`Explore`, `quick`, `bulk`,
`build`, `autopilot-owner`, `general-purpose`) stay Claude Code agent files. The in-session tool list is their
whole boundary, and the parent's session mode governs them. *Launched roles* (`review`, `pr-review`,
`adversarial-review`, and `build`'s overflow binding) live in a new `roles/` directory, and only `agentic child`
starts them, as separate processes. A role name maps to exactly one launch path, except `build`, which has a
native default binding and a launched overflow binding. The routing hook chooses between them; the parent does
not. `review.md` and `pr-review.md` leave `claude/agents/`, so the Agent tool can no longer start a shell-less
copy of a reviewer by mistake.

### Boundaries

One contract with two enforcers, and one proof (`doctor`) that holds both to the contract.

| | `probe` (review, pr-review, adversarial-review) | `overflow-build` (build on Pi) |
| --- | --- | --- |
| Working directory | fresh snapshot: `git archive <head>` extracted, plus `--with` paths cloned with `cp -c`; no `.git` | the given worktree, in place |
| Writes allowed | the snapshot, the attempt's `home/`, `tmp/`, `session/` | the worktree minus its `.git` file, plus the attempt's `home/`, `tmp/`, `session/` |
| Writes denied | everything else, including the checkout under review, the git common dir, `~/.claude`, the run's own result files | everything else, including the git common dir (no commit, no ref change) |
| File-writing tools | removed (Claude: `Edit`, `Write`, `NotebookEdit`; Pi: `edit`, `write`) | present |
| Publishing | Claude: the sandbox network allowlist excludes GitHub. Pi: credential reads denied (`~/.ssh`, `~/.config/gh`, `~/.netrc`, `~/.git-credentials`, keychain mach services); `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` scrubbed | same as `probe` for Pi |
| Configuration from the workspace | not loaded. Claude: `--restricted` (ignores user, project, and local settings files), `--strict-mcp-config` with no servers, `--disable-slash-commands`. Pi: `--no-approve`, `--no-extensions -e <kit>/pi/extensions/lithosai.ts`, `--no-mcp`, `--no-skills`, `--no-prompt-templates` | same, Pi flags |
| Launching children | Claude: `--disallowedTools Agent`. Pi: no subagent extension loaded. A nested `claude` or `pi` from the shell finds no credentials (Pi) or no network to the API (Claude) | same |
| Enforcer | Claude: Claude Code's own sandbox on `Bash`, from `--settings` (`enabled`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, auto-allow when sandboxed, a network allowlist of package registries only). Pi: agent-kit's Seatbelt profile (`sandbox-exec`) or `bwrap` argv around the whole `pi` process | Pi: agent-kit's Seatbelt or `bwrap` around the whole `pi` process |

Why Claude uses its own sandbox and not agent-kit's profile: wrapping the whole `claude` process would have to
allow writes to `~/.claude` and `~/.claude.json`. A sandboxed reviewer could then plant hooks or MCP servers that
every later session runs. Moving `CLAUDE_CONFIG_DIR` avoids that but loses the keychain login (**verify** how
the keychain item is named per config dir). Claude's own sandbox confines only the shell, which is the part the
model controls, and it filters network by domain, which Seatbelt cannot do. Pi has no shell sandbox of its own,
so agent-kit wraps the whole process. Pi's own writes go to `--session-dir` inside the attempt, and its auth
lives in a readable file (`pi/extensions/lithosai.ts`: auth.json, or `LITHOSAI_API_KEY`).

The child's permissions never prompt, so an unattended child cannot stall. Claude runs `--permission-mode
default --permission-prompts none` with auto-allow for sandboxed `Bash`: anything that would prompt is denied.
Pi has no prompts. Neither child gets a mode broader than a default session. Every capability it has beyond
reading is bounded by the OS sandbox.

### Core data structures and the access patterns that run through them

**`RoleTable`**: `ReadonlyMap<RoleName, RoleEntry>`, built once per process from `claude/agents/*.md` and
`roles/*.md` by one parser, which `scripts/check-skills.ts` also uses. A `RoleEntry` is a native role (default
binding only), a launched role, or `build`, which holds both its native binding and its overflow binding. The
table's invariants are checked once, at load: each name maps to one entry; a launched role named in
`claude/agents/` is an error; an overflow binding needs a native binding with the same name; panel members need
a verdict-style charter.

**`Workspace`**: a discriminated union, `snapshot` or `worktree`. A `probe` role accepts only `snapshot`, and
`overflow-build` accepts only `worktree`. The request types encode this, so `run review --worktree` cannot be
expressed past argv parsing.

**`RunDir`**: one directory per launch, written only by the launcher process.

```text
~/.local/state/agentic/children/<repo-key>/<run-id>/
  run.json                 written once at start: request, bindings, head, base, patch ID, launcher pid
  <lane>/input/            brief.md, diff.patch, intent.md, prior.md, pr-review.md (installed copy)  read-only to the child
  <lane>/attempt-<n>/work  snapshot (probe) - deleted when the lane ends unless --keep
  <lane>/attempt-<n>/{home,tmp,session}
  <lane>/attempt-<n>/events.jsonl   harness stdout, written by the launcher from the pipe
  <lane>/result.json       written once, by temp file and rename, when the lane ends
  <lane>/report.md         stamped report, written before result.json
```

For a Claude lane the inputs are copied into `work/.agentic-child/`, because `--restricted` confines the read
tools to the working directory. That copy is the reviewer's own and changes nothing that matters. The
authoritative inputs stay under `input/`. A tree that already contains `.agentic-child/` is refused.

Access patterns, traced:

1. **Panel review.** argv → `PanelRequest` (validated: head is a commit present locally; with no `--head`,
   tracked files must be clean; base resolves) → `RoleTable.get(lane)` for each panel role → per lane, in
   parallel: `makeSnapshot` → `planAttempt` (pure) → spawn → `observe(events)` (pure) → `classifyAttempt`
   (pure) → `retry` or `final` → `stampReport` (pure) → write `report.md`, then `result.json` → summary lines
   derived from the lane results. Lanes share no mutable state. Each owns `<lane>/`, and the launcher is the
   single writer of every file a lane produces.
2. **Overflow route.** Hook stdin (`tool_input.subagent_type`, `tool_input.prompt`) → `parseRisk(prompt)` →
   `agentic quota pace`, with a 2 s budget → `routeBuild(risk, pace)` (pure, a table) → allow, or deny with
   reason. On deny, the brief is written to `briefs/<content-hash>.md` once. Same content gives the same file,
   so a repeated deny is idempotent.
3. **Overflow build.** argv → `BuildRequest` → `routeBuild` again (the launcher does not trust the hook) →
   `lockWorktree` → plan → spawn → observe → `changedPaths(worktree)` → `policyPaths(changed)`, which reuses
   `POLICY_PATHS` from `agentic/tools/verify/verify.ts` so the list has one source → `built` or `misrouted` →
   release the lock.
4. **Status after a crash or a context reset.** `run.json` plus the `result.json` files present → the state is
   derived, never stored: `done`, `running` (launcher pid alive), or `interrupted` (no result and the pid is
   dead).

### Types and signatures

```ts
// agentic/tools/child/roles.ts — the role table. Pure; check-skills imports the same parser.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type PiThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudeModel = "claude-opus-5-5" | "claude-haiku-5-5";

/** The user's fixed role names. A role file whose name is not here fails check-skills. */
export type RoleName =
  | "Explore" | "quick" | "bulk" | "build" | "review" | "pr-review"
  | "autopilot-owner" | "general-purpose" | "adversarial-review";
export type ProbeRole = "review" | "pr-review" | "adversarial-review";
export type PanelRole = Extract<ProbeRole, "pr-review" | "adversarial-review">;
/** Every pull request gets every lane here, in parallel. Changing the panel is a one-line diff here. */
export const PR_PANEL: readonly PanelRole[] = ["pr-review", "adversarial-review"];

/** An exact `provider/id` from pi's catalog. Never a pattern: pi's --model fuzzy-matches patterns. */
export type PiModelId = string & { readonly __brand: "PiModelId" };

export type ClaudeBinding = { readonly harness: "claude"; readonly model: ClaudeModel; readonly effort: Effort };
export type PiBinding = { readonly harness: "pi"; readonly model: PiModelId; readonly thinking: PiThinking };
export type Binding = ClaudeBinding | PiBinding;

export type LaunchedRole =
  | { readonly name: ProbeRole; readonly boundary: "probe"; readonly binding: Binding;
      readonly charter: string; readonly timeoutMs: number }
  | { readonly name: "build"; readonly boundary: "overflow-build"; readonly binding: PiBinding;
      readonly charter: string; readonly timeoutMs: number };

export type RoleEntry =
  | { readonly kind: "native"; readonly name: Exclude<RoleName, ProbeRole | "build">; readonly binding: ClaudeBinding }
  | { readonly kind: "launched"; readonly role: Extract<LaunchedRole, { boundary: "probe" }> }
  | { readonly kind: "build"; readonly native: ClaudeBinding; readonly overflow: Extract<LaunchedRole, { name: "build" }> };

export type RoleTable = ReadonlyMap<RoleName, RoleEntry>;

/** Parses one roles/*.md file. Throws an Error naming the path and the field. */
export function parseLaunchedRole(path: string, text: string): LaunchedRole { throw new Error("not implemented"); }
/** Reads claude/agents/*.md and roles/*.md under the kit and checks the table invariants. Throws on the first violation. */
export function loadRoleTable(kitRoot: string): RoleTable { throw new Error("not implemented"); }
```

```ts
// agentic/tools/child/route.ts — the overflow decision. Pure.

export type Risk = "routine" | "security" | "verification-policy" | "concurrency" | "data-format";
export type Pace = "under" | "over" | "exhausted";
export type PaceReading = { readonly kind: "read"; readonly pace: Pace } | { readonly kind: "unknown"; readonly why: string };

export type BuildRoute =
  | { readonly kind: "claude"; readonly note: string | null }       // note set when pace was unknown
  | { readonly kind: "overflow" }
  | { readonly kind: "unavailable"; readonly why: string };          // risky work and Claude exhausted

/** routine+under -> claude; routine+over|exhausted -> overflow; risky+exhausted -> unavailable; risky+else -> claude;
 *  unknown pace -> claude with a note (the default binding, not a substitution). */
export function routeBuild(risk: Risk, pace: PaceReading): BuildRoute { throw new Error("not implemented"); }
/** The first line matching /^Risk: (routine|security|verification-policy|concurrency|data-format)$/m, or null. */
export function parseRisk(brief: string): Risk | null { throw new Error("not implemented"); }

export type HookDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };
/** The Agent PreToolUse hook. Non-build launches are allowed untouched. A build brief with no Risk line is denied with the fix.
 *  `saveBrief` writes a content-addressed file and returns its path. */
export function agentHookDecision(
  input: { readonly subagentType: string | null; readonly prompt: string },
  pace: () => PaceReading,
  saveBrief: (text: string) => string,
): HookDecision { throw new Error("not implemented"); }
```

```ts
// agentic/tools/child/request.ts — what the CLI accepts, validated at the boundary.

export type AbsPath = string & { readonly __brand: "AbsPath" };
export type CommitSha = string & { readonly __brand: "CommitSha" };   // full 40-hex, resolved, present locally

export type SnapshotSource =
  | { readonly kind: "commit"; readonly repo: AbsPath; readonly head: CommitSha }
  | { readonly kind: "dir"; readonly path: AbsPath };

export type PanelRequest = {
  readonly repo: AbsPath; readonly head: CommitSha; readonly base: CommitSha;
  readonly since: CommitSha | null;          // focused re-review: diff since..head instead of merge-base(base)..head
  readonly intent: string; readonly prior: string | null;
  readonly only: readonly PanelRole[];       // defaults to PR_PANEL
  readonly withPaths: readonly string[];     // e.g. node_modules, cloned with cp -c into each snapshot
};
export type ReviewRequest = { readonly role: "review"; readonly source: SnapshotSource; readonly brief: string; readonly withPaths: readonly string[] };
export type BuildRequest = { readonly role: "build"; readonly worktree: AbsPath; readonly brief: string; readonly risk: Risk };

/** argv -> request. Throws a usage error naming the flag. Resolves refs to CommitSha and refuses a dirty tree when --head is implicit. */
export function parseArgs(argv: readonly string[], cwd: string): { readonly command: "pr"; readonly request: PanelRequest }
  | { readonly command: "run"; readonly request: ReviewRequest | BuildRequest }
  | { readonly command: "doctor" } | { readonly command: "status"; readonly runId: string | null }
  | { readonly command: "claude-hook" } { throw new Error("not implemented"); }
```

```ts
// agentic/tools/child/sandbox.ts — the boundary as data, rendered per enforcer. Pure.

export type Confinement = {
  readonly writable: readonly AbsPath[];          // snapshot or worktree, plus attempt home/tmp/session
  readonly denyWrite: readonly AbsPath[];         // carve-outs inside writable, e.g. <worktree>/.git
  readonly denyRead: readonly AbsPath[];          // credential paths under the real HOME
  readonly denyKeychain: boolean;
  readonly network: { readonly kind: "open" } | { readonly kind: "domains"; readonly allow: readonly string[] };
};

export function confinementFor(boundary: "probe" | "overflow-build", paths: AttemptPaths, realHome: AbsPath): Confinement { throw new Error("not implemented"); }
/** Seatbelt profile text for sandbox-exec. Rejects network "domains", which Seatbelt cannot express. */
export function seatbeltProfile(c: Confinement): string { throw new Error("not implemented"); }
export function bwrapArgs(c: Confinement): readonly string[] { throw new Error("not implemented"); }
/** The --settings JSON for a Claude child: sandbox enabled, fail-if-unavailable, no unsandboxed escape, domain allowlist. */
export function claudeSandboxSettings(c: Confinement): unknown { throw new Error("not implemented"); }
```

```ts
// agentic/tools/child/plan.ts — one attempt as data. Pure.

export type AttemptPaths = { readonly lane: AbsPath; readonly attempt: AbsPath; readonly work: AbsPath; readonly home: AbsPath; readonly tmp: AbsPath; readonly session: AbsPath; readonly input: AbsPath };
export type Host = { readonly os: "darwin" | "linux"; readonly kitRoot: AbsPath; readonly realHome: AbsPath; readonly path: string };

export type LaunchPlan = {
  readonly argv: readonly string[];           // claude -p ... | sandbox-exec -f <profile> pi -p ... | bwrap ... pi -p ...
  readonly env: Readonly<Record<string, string>>;   // an allowlist, never the parent's whole environment
  readonly cwd: AbsPath;
  readonly stdin: string;                     // the brief
  readonly timeoutMs: number;
  readonly stream: "claude-stream-json" | "pi-json";
  readonly files: ReadonlyMap<AbsPath, string>;   // profile, settings, charter: written by the shell before spawn
};

export function planAttempt(role: LaunchedRole, paths: AttemptPaths, host: Host): LaunchPlan { throw new Error("not implemented"); }
```

```ts
// agentic/tools/child/outcome.ts — what the harness did, judged against the binding. Pure.

export type Verdict = "PASS" | "PASS+NOTES" | "FAIL";
export type ProviderFailure =
  | { readonly kind: "overloaded"; readonly detail: string }     // 429, 5xx: retried on the same binding
  | { readonly kind: "network"; readonly detail: string }        // connection reset, DNS: retried on the same binding
  | { readonly kind: "usage-limit"; readonly detail: string }    // Claude weekly limit, subscription cap: final
  | { readonly kind: "auth"; readonly detail: string }           // final
  | { readonly kind: "model-missing"; readonly detail: string }; // final

/** Parsed events: every model that produced an assistant turn, the final text, and any provider error. */
export type Observation = {
  readonly turnModels: ReadonlySet<string>;   // Claude: assistant message.model. Pi: assistant event provider/model.
  readonly finalText: string | null;
  readonly failure: ProviderFailure | null;
  readonly exitCode: number | null; readonly timedOut: boolean;
};
export function observe(stream: LaunchPlan["stream"], events: string, exitCode: number | null, timedOut: boolean): Observation { throw new Error("not implemented"); }

export type LaneOutcome =
  | { readonly kind: "reported"; readonly role: ProbeRole; readonly model: string; readonly verdict: Verdict | null; readonly report: AbsPath; readonly attempts: number }
  | { readonly kind: "built"; readonly model: string; readonly changed: readonly string[]; readonly report: AbsPath; readonly attempts: number }
  | { readonly kind: "misrouted"; readonly model: string; readonly policyPaths: readonly string[]; readonly report: AbsPath }
  | { readonly kind: "unreachable"; readonly role: RoleName; readonly binding: Binding; readonly failure: ProviderFailure; readonly attempts: number }
  | { readonly kind: "substituted"; readonly role: RoleName; readonly bound: string; readonly observed: readonly string[]; readonly events: AbsPath }
  | { readonly kind: "malformed"; readonly role: RoleName; readonly model: string; readonly problem: string; readonly events: AbsPath }
  | { readonly kind: "timed-out"; readonly role: RoleName; readonly afterMs: number; readonly events: AbsPath };

export type AttemptVerdict = { readonly kind: "retry"; readonly failure: ProviderFailure; readonly afterMs: number } | { readonly kind: "final"; readonly outcome: LaneOutcome };

/** Decides one attempt. Order: substitution (any turn model != bound, exact match) beats everything; then a provider
 *  failure (retry if overloaded|network and attempt < 3, backoff 30 s then 120 s); then timeout; then report shape
 *  (a panel role needs exactly one `verdict:` line). */
export function classifyAttempt(role: LaunchedRole, obs: Observation, attempt: number, paths: AttemptPaths): AttemptVerdict { throw new Error("not implemented"); }

/** The launcher's header (`reviewed by <observed model> (<role>)`, run, head, patch) above the child's text, with any
 *  `reviewed by` line the child wrote removed: the observed model is the one source for that line. */
export function stampReport(role: RoleName, model: string, run: RunHeader, childText: string): string { throw new Error("not implemented"); }
export type RunHeader = { readonly runId: string; readonly head: CommitSha | null; readonly patchId: string | null };
```

```ts
// agentic/tools/child/run.ts — the shell: workspaces, spawning, retries, files. Thin; every decision is a call above.

export type Deps = {
  readonly spawn: (plan: LaunchPlan, eventsFile: AbsPath) => Promise<{ exitCode: number | null; timedOut: boolean }>;
  readonly pace: () => PaceReading;
  readonly now: () => Date; readonly sleep: (ms: number) => Promise<void>;
  readonly host: Host; readonly stateRoot: AbsPath;
};
export type PanelOutcome = { readonly runId: string; readonly dir: AbsPath; readonly lanes: ReadonlyMap<PanelRole, LaneOutcome> };

export function runPanel(request: PanelRequest, table: RoleTable, deps: Deps): Promise<PanelOutcome> { throw new Error("not implemented"); }
export function runOne(request: ReviewRequest | BuildRequest, table: RoleTable, deps: Deps): Promise<{ readonly runId: string; readonly outcome: LaneOutcome } | { readonly kind: "route"; readonly route: Exclude<BuildRoute, { kind: "overflow" }> }> { throw new Error("not implemented"); }
export type RunState = { readonly runId: string; readonly lanes: ReadonlyMap<string, LaneOutcome | "running" | "interrupted"> };
export function runState(dir: AbsPath, pidAlive: (pid: number) => boolean): RunState { throw new Error("not implemented"); }

/** Creates <worktree's gitdir>/agentic-child.lock with O_EXCL, holding pid and start time. A lock whose pid is dead is
 *  taken over, and the takeover is reported. Throws when a live launcher holds it: one writer per worktree. */
export function lockWorktree(worktree: AbsPath): { release(): void; tookOverFrom: string | null } { throw new Error("not implemented"); }
```

```ts
// agentic/tools/child/doctor.ts — the boundary contract, proven per harness version.

export type Proof =
  | { readonly kind: "proven"; readonly harness: "claude" | "pi"; readonly version: string; readonly boundary: "probe" | "overflow-build"; readonly checks: readonly string[] }
  | { readonly kind: "failed"; readonly harness: "claude" | "pi"; readonly version: string; readonly boundary: "probe" | "overflow-build"; readonly check: string; readonly evidence: string }
  | { readonly kind: "inconclusive"; readonly harness: "claude" | "pi"; readonly why: string };   // treated as failed

/** Pi: runs the rendered sandbox around `sh -c` directly (no model call): a canary write outside, a credential read, a
 *  keychain lookup, all must fail; a write inside must succeed. Claude: one claude-haiku-5-5 run under the probe
 *  flags told to run those commands with Bash; proven only when the events show each command ran and failed and the
 *  canary file is absent. Also checks each binding's exact model ID in `pi --list-models`. Writes a stamp keyed by version. */
export function doctor(deps: Deps): Promise<readonly Proof[]> { throw new Error("not implemented"); }
```

### Role files

`roles/pr-review.md` holds the binding and the charter for the panel procedure. `adversarial-review` points at
that charter, so both lanes run one procedure on two model families.

```markdown
---
name: pr-review
description: Adversarial review of a pull request's diff, launched only by `agentic child pr`.
harness: claude
model: claude-opus-5-5
effort: xhigh
boundary: probe
timeout: 25m
---
You are the adversarial pull-request reviewer. You did not write the change. Your working directory is a
disposable copy of the reviewed commit, with no git history; nothing you change in it reaches the code under
review, so run its tests and write probes there freely. Your inputs are in `.agentic-child/`: `pr-review.md`
(the installed review procedure; its "Reviewer brief" is your method), `diff.patch`, `intent.md`, and, for a
focused re-review, `prior.md`. ... Do not write a `reviewed by` line; the launcher writes it from the model
that ran. Open with the `rules:` line, then `verdict:` ...
```

```markdown
---
name: adversarial-review
description: The pull-request panel's second lane, on a second model family.
harness: pi
model: lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017
thinking: max
boundary: probe
charter: pr-review
timeout: 25m
---
```

```markdown
---
name: build
description: Overflow binding of build for routine work when the week's Claude usage is ahead of pace.
harness: pi
model: lithosai/deepseek-ai/DeepSeek-V4.1-Flash
thinking: high
boundary: overflow-build
timeout: 60m
---
You carry out a routine implementation brief in the worktree you start in. You cannot commit: leave your
changes uncommitted, and the parent commits after reading them. If the work turns out to touch security,
verification policy, concurrency, or a data format, stop, leave the tree as it is, and open your report with
`misrouted: <class>: <why>`. ...
```

### Module map

```text
roles/                                    NEW  launched roles: frontmatter binding + charter (the only non-Claude model bindings)
  review.md  pr-review.md  adversarial-review.md  build.md
agentic/tools/child/                      NEW
  roles.ts        RoleTable, parser, invariants             pure   (imported by scripts/check-skills.ts)
  route.ts        routeBuild, parseRisk, agentHookDecision  pure
  request.ts      argv -> PanelRequest | ReviewRequest | BuildRequest, validated   (git reads only)
  sandbox.ts      Confinement -> Seatbelt | bwrap | Claude settings              pure
  plan.ts         LaunchedRole x AttemptPaths x Host -> LaunchPlan              pure
  outcome.ts      observe, classifyAttempt, stampReport                         pure
  run.ts          snapshot, lock, spawn, retry, write run dir                   shell
  doctor.ts       boundary proofs and reachability                              shell
  cli.ts          pr | run | doctor | status | --claude-hook                    shell, thin
  *.test.ts       table-driven tests on every pure function; recorded event fixtures (Claude stream-json, Pi json, a 429)
agentic/bin/agentic                       + child
agentic/tools/verify/verify.ts            export POLICY_PATHS matching (already exported) - reused, not copied
scripts/check-skills.ts                   roles from loadRoleTable; models: claude/agents Claude-only, roles/ also lithosai/*;
                                          roles/ exempt from the no-model-ID scan; the role line must name every RoleName
claude/agents/review.md, pr-review.md     REMOVED (charters move to roles/)
claude/CLAUDE.md, pi/AGENTS.md            role line: review, pr-review, adversarial-review launch through `agentic child`;
                                          build briefs carry a Risk line; a lane reported unreachable is recorded, not replaced
claude/README.md                          install contract: the Agent PreToolUse hook (`agentic child --claude-hook`,
                                          onFailure block); remove the review and pr-review links; allow `Bash(agentic child:*)`
skills/git-workflow/references/pr-review.md   step 4 and 7: run the panel; record each lane's line
skills/babysit-and-ship/references/{shipping,autopilot-full,pr-body}.md   audit lane = the panel; review record holds one line per lane
skills/{design-checkpoint,reflect,show-me-your-work,background-run}       `review` launches via `agentic child run review`
.agents/skills/verify-agent-kit/          a drive for `agentic child doctor` and a panel run on a fixture PR
```

### Repeatability and crashes

- **The same review twice.** Two runs with separate directories and separate snapshots. They share nothing and
  cost twice. No dedup: a fresh reviewer is the point.
- **The launcher dies mid-run.** It runs children in its own process group and kills the group on `SIGINT` or
  `SIGTERM`. After a hard crash, an orphaned child finishes in its own snapshot and nobody records it.
  `agentic child status` derives `interrupted` from the missing `result.json` and the dead pid. The fix is a new
  run, never a resume, which matches "never resume-chain a child".
- **A lane dies on the provider.** The launcher retries the same binding, at most three attempts, each in a
  fresh `attempt-<n>/` with a fresh snapshot. It never changes model or tier. Pi may retry internally first, and
  that is fine.
- **An overflow build dies halfway.** Partial edits stay in the worktree. The next `run build` on that worktree
  takes over the stale lock, reports `previous overflow run <id> was interrupted; its edits are in the
  worktree`, and starts from whatever is there. Discarding them is the parent's call.
- **The hook denies twice for the same brief.** The brief file is content-addressed, so the second write is a
  no-op.
- **Retention.** Each run prunes its repository's run directories older than 14 days. It deletes only
  directories whose names match its own run-id pattern. Snapshots are deleted when their lane ends.

## Tradeoffs accepted

- **Reviews leave the session.** The parent sees reports and an events file, not a live sub-transcript. Every
  review pays a headless startup that loads instructions. In exchange, a reviewer can run code without being
  able to touch the code under review. In-session subagents cannot give that, because the sandbox is per
  session.
- **Two enforcers for one boundary contract.** Claude's native sandbox confines Claude reviewers, and agent-kit's
  Seatbelt or bwrap confines Pi. `doctor` proves both against the same checks on every harness version. The
  alternative was one enforcer that either breaks Claude's auth or lets a reviewer write `~/.claude`.
- **Pi children have open network.** Seatbelt cannot filter by domain, and `pi` must reach LithosAI. Publishing
  is blocked by denying credentials, not the network: no `gh` token, SSH keys, or keychain. A Pi reviewer can
  still send what it reads to any host, which matters for private repositories. It can also read the LithosAI
  key Pi itself reads.
- **Overflow builds cannot commit.** The git directory is outside the sandbox, so the parent commits after
  reading the diff. That costs one parent step per overflow build. The alternative was letting a non-Claude
  child write refs in the shared git directory.
- **Risk is the parent's declaration.** Only verification policy has a path oracle (`POLICY_PATHS`), so only
  that class is caught after the fact (`misrouted`). Security, concurrency, and data formats rest on the
  parent's `Risk:` line and on the overflow charter's instruction to stop.
- **Every round runs both lanes.** That includes focused re-reviews, at Opus `xhigh` cost each time, because
  the panel is the unit and "every pull request gets both" stays a fact rather than a habit.
- **`build` keeps two launch paths.** Native for Claude, launched for overflow, with the hook as the single
  chooser. This is the one place a role has two paths. The second binding has a different model, boundary, and
  charter (no commits), so it is not the same launch spelled twice.
- **No reviewer fallback.** When `agentic` cannot run, for example because the parent's own Bash is sandboxed
  and blocks `sandbox-exec` or the state directory, reviews are unavailable and reported as such. No read-only
  native reviewer is left as a second way in.
- **macOS and Linux only.** `sandbox-exec` is deprecated but present on this machine. Linux uses `bwrap`, which
  is not installed here, so the Linux path is untested until CI or a Linux host runs `doctor`.

## Alternatives considered

- **T3 `delegate_task` routing**, the deferred plan in `docs/design/model-roles.md`. Rejected: T3 children
  inherit the parent's working directory with no per-child sandbox, so a reviewer could edit the code under
  review, and it does not exist in a plain terminal session. This reverses that document's "through the T3
  routing" line for both new children.
- **In-session reviewers with `Bash`.** Rejected: a subagent cannot have a stricter sandbox than its session,
  and `Bash` can write the checkout. Keeping them read-only gives up the evidence that runnable reviewers find
  more.
- **One enforcer: agent-kit's Seatbelt around the whole `claude` process too.** Rejected for Claude: Claude
  writes `~/.claude.json` and `~/.claude/` and reads its login from the keychain. Allowing those writes lets a
  prompt-injected reviewer plant hooks or MCP servers for later sessions, and relocating `CLAUDE_CONFIG_DIR`
  loses the login. Kept for Pi, which has no shell sandbox to use.
- **An agent-kit MCP "probe" server as the only shell, for both harnesses.** One enforcer and one tool, but it
  is a second shell implementation to maintain (timeouts, output limits, background processes). Models are
  trained on their native shell tool, and it gives up Claude's domain-filtered network.
- **Rewriting each Bash command through a `PreToolUse` hook into `sandbox-exec`.** Rejected: it fails open. In
  `-p` mode, a settings file that fails validation is ignored silently (`claude --help`, `--print`), and then
  commands run unconfined. A whole-process wrap (Pi) or the vendor sandbox with `failIfUnavailable` plus `doctor`
  (Claude) fails closed.
- **The launcher runs every `build`, Claude too, headless.** One path for the role. Rejected: verifiers run as
  `build` and need Docker, `gh`, and the parent's session mode. A headless, sandboxed Claude build would break
  them or need a broad mode.
- **Overflow by instruction only** (the parent runs `agentic quota pace` before each build). Rejected as
  unenforced prose. The hook makes the route impossible to skip in Claude Code, and `run build` checks it again.
- **A `--fallback-model` or `onLimit` binding for reviewers.** Rejected by the user's decision: an unreachable
  model is reported. The launcher also fails a lane as `substituted` when the harness falls back on its own.

## Open questions and risks

Decisions for the user:

1. **When the `adversarial-review` lane is unreachable after its retries**, does the pull request wait?
   - (a) It proceeds, with the lane recorded as unreachable in the review record and under "Needs you".
   - (b) It waits until the lane returns.
   - Recommendation and default: (a) after one `--only adversarial-review` rerun. The Base and Fast tiers stayed
     up in the benchmark, so outages should be short, and (b) would let a third-party provider stop the
     user's merges.
2. **This is a security boundary and a one-way door.** It covers the probe and overflow-build boundaries, the
   `roles/` file format, the `agentic child` command surface that skills will name, and removing the native
   `review` and `pr-review` agents. The shape should be reviewed before building (`design-checkpoint`). The
   `RoleTable` is a core data structure, and the parallel lanes and worktree lock are the concurrency model.
3. **Open network for Pi children.** The options are (a) accept it, the default; (b) route Pi's traffic through
   a local proxy with a domain allowlist; or (c) allow LithosAI's IPs only, which is brittle. (b) costs a proxy
   process per run. Recommendation: (a) now, (b) when a private repository is reviewed.

Risks to verify while building:

- **The model ID.** `DeepSeek-V4.1-Flash-1017` is not in `pi --list-models` on this machine. Only `-0910` and
  the floating ID are listed. Until it appears, the panel's second lane reports `unreachable: model-missing`
  every time. Pi's `--model` accepts patterns and fuzzy matching, so the launcher checks the exact ID before
  launching and against the observed turn model after.
- **`pi auth check --provider lithosai` returns `provider_not_found`**, likely because it does not load
  extensions. Readiness therefore comes from `pi --list-models <exact id>` and a real run, not from `auth check`.
- **Claude `--restricted`** ignores user, project, and local settings files (`claude --help`). Verify that
  `--settings` still enables the sandbox under it, that `CLAUDE.md` and the user's instructions still load,
  and that its read confinement does not block reading inside the working directory.
- **The Claude sandbox setting names** in 2.1.302 for the domain allowlist, auto-allow, and
  `failIfUnavailable`. `doctor` is the proof. The grounding confirms only `enabled`,
  `allowUnsandboxedCommands`, and `failIfUnavailable`.
- **Observed model from Claude events.** The plan assumes each assistant event in `stream-json` carries
  `message.model`. `modelUsage` alone is not enough, because Claude Code may use a small model for internal
  calls such as Bash prefix checks.
- **Pi under Seatbelt with keychain denied.** Verify that Pi still starts, authenticates from auth.json, and
  writes only to `--session-dir` and its tmp. If it writes inside `PI_CODING_AGENT_DIR` (model caches, update
  checks), `--offline` or a writable cache path is the fix. Allowing writes to the agent directory is not.
- **The parent's own sandbox.** A parent session with Claude's sandbox enabled cannot run `sandbox-exec` (nested
  Seatbelt) or write the state directory. `agentic child` would need to be excluded from that sandbox, a setting
  that belongs to the user. On this machine the parent is not sandboxed.
- **Hook latency.** `agentic quota pace` must answer within the hook's 2 s budget, or the hook treats the pace
  as unknown and keeps `build` on Claude. That requirement goes to whoever builds `agentic quota pace`.
- **Rules read from the head.** The reviewer reads `rules.toml` and `AGENTS.md` from the snapshot, so a pull
  request can weaken its own review rules. This holds today as well, so it is out of scope as a follow-up and
  not part of this design.
- **Installs.** Removing `claude/agents/review.md` and `pr-review.md` leaves dangling links in installs that
  link files one by one. `claude/README.md` states the new contract, and each installer changes in its own
  repository (`AGENTS.md`, Standalone).

## First implementation step

Prove the boundaries before anything depends on them. On `agent/child-launcher`, add
`agentic/tools/child/{roles,sandbox,plan,outcome}.ts`, `doctor.ts`, `cli.ts doctor`, `roles/adversarial-review.md`,
and `roles/pr-review.md`, with tests. The step is done when:

- `sandbox.test.ts` renders the probe and overflow-build profiles. Run under `sandbox-exec` around `sh -c`, the
  probe profile denies a write to a temp-dir canary outside the workspace, a read of a fake `~/.config/gh/hosts.yml`
  placed under a test home, and a keychain lookup (`security find-generic-password -s agentic-doctor-canary`,
  expected to fail with a sandbox denial, not item-not-found), and it allows a write inside the workspace. The
  same test with the deny rule removed fails, as a negative control.
- `outcome.test.ts` classifies recorded fixtures as follows. A Pi `429 provider_overloaded` is `retry`. A Pi run
  whose turn model differs from the bound ID is `substituted`. A Claude stream with a usage-limit error is
  `unreachable`. A report with no `verdict:` line is `malformed`. `stampReport` removes a child-written
  `reviewed by` line.
- `agentic child doctor` on this machine prints `proven` for Claude's probe boundary (one Haiku run, with the
  canary absent and the events showing the denied commands) and for Pi's probe boundary. It prints the exact
  reachability of both Flash IDs, which today should show `-1017` as `unreachable: model-missing`.
- `scripts/validate` passes with `check-skills.ts` loading roles through `loadRoleTable`.

Slices that follow, in order:

1. `agentic child pr` on a fixture pull request, with both lanes, the stamped reports, and `status`.
2. The skill text and instruction changes, and removing the native reviewers.
3. `routeBuild`, the Agent hook, and `run build` with the lock and the `misrouted` check.
4. The `verify-agent-kit` drives.
