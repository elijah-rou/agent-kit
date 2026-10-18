# Sealed runs: reviewers that can run code but not edit it, and an overflow builder

Candidate B. One command, `agentic run <role>...`, launches every child that needs a boundary the in-session
Agent tool cannot give. Each run gets its own sealed scratch clone of the exact head, runs as a separate OS
process under a sandbox the launcher builds, and leaves a result file. The launcher is the only writer of
the real repository and of the run record. The same mechanism carries both kinds of child the task names:
reviewers (their output is a report) and the overflow builder (its output is a report plus a branch).

## Problem

agent-kit cannot launch two kinds of child today.

1. **Reviewers that run tests and probes but cannot edit.** `review` and `pr-review` are Claude Code
   subagents with `tools: Read, Grep, Glob`, a real read-only boundary but one that cannot run anything. The
   2026-10-18 benchmark found a hook-skip bypass that only a reviewer with a runnable copy caught. Adding
   Bash to an in-session subagent is not a boundary: Bash can write through any program, and Claude Code's
   sandbox applies to the whole session, so a subagent cannot get a stricter sandbox than its parent, whose
   working directory is the checkout under review. A new `adversarial-review` role must run on DeepSeek V4.1
   Flash 1017 at thinking `max` through Pi, which has no sandbox at all. Every pull request gets
   `pr-review` and `adversarial-review` in parallel.
2. **An overflow builder.** When `agentic quota pace` prints `over` or `exhausted`, routine `build` work
   runs on DeepSeek V4.1 Flash at thinking `high` on LithosAI's Base tier instead of Claude. Risky work
   (security, verification policy, concurrency, data formats) stays on Claude.

Constraints already decided by the user: role names stay, plus `adversarial-review`; subagents are no
longer Claude-only; reviewers may run tests and probes but must not be able to edit the code under review;
an unreachable model is reported, never silently replaced. From the grounding: T3's `delegate_task` exists
only inside T3, and its children inherit the parent's working directory with no per-child sandbox, so it
cannot carry either boundary. LithosAI Ultra returned `429 provider_overloaded` for long stretches, and the
ChatGPT provider hit a usage limit and failed every run, so provider failure is the normal case to design
for.

The doors this crosses: a security boundary (what a child can write), a persisted format (the run result
the review record cites), and the concurrency model for parallel children. These are the user's hard parts.

## Usage (caller's view)

### Quickstart

Review the current pull request with both reviewers, in parallel, in one call:

```sh
agentic run pr-review adversarial-review --base origin/main --brief /tmp/intent.md
```

```
pr-review           done  FAIL        reviewed by claude-opus-5-5 (xhigh), run pr-review-3f9c2e1-a71b40c2       7m12s
adversarial-review  done  PASS+NOTES  reviewed by lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017 (max), run adversarial-review-3f9c2e1-c04d9e11  6m40s
reports: agentic run show <run>
```

`--head` defaults to `HEAD` and must name a commit. The brief is the intent paragraph; the launcher builds
the rest of the reviewer's inputs itself (the diff, the pinned review procedure). The command blocks until
every role finishes, so a Claude Code parent runs it with Bash's `run_in_background` and is woken on exit.
Exit status: 0 when every role finished (whatever the verdicts), 1 when any role was unavailable, 3 when any
run was refused, 2 for a usage error. A `FAIL` verdict is a finished review, not a failed run.

### Call site 1: the pull-request review (`git-workflow`'s `pr-review.md`, step 4)

Before opening the pull request or marking it ready:

```sh
agentic run pr-review adversarial-review --base "$(git merge-base origin/main HEAD)" --brief .scratch/intent.md
```

The parent reads each report with `agentic run show <run>`, judges the findings, and copies one line per
reviewer into the pull request's `## Review record`:

```markdown
## Review record

reviewed by claude-opus-5-5 (xhigh), round 1, run pr-review-3f9c2e1-a71b40c2
- missing-rerun-guard: fixed: retry after a partial write duplicated the ledger row
reviewed by lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017 (max), round 1, run adversarial-review-3f9c2e1-c04d9e11
- hook-bypass: fixed: SKIP_HOOKS=1 skipped the secret scan
```

The `reviewed by` text comes from the launcher, which reads the model that actually ran from the engine's
own output. It is never the reviewer's self-report: a model asked its name can get it wrong.

A focused re-review after a fix pass is the same call with the round-1 head as base and the prior accepted
findings as an input file:

```sh
agentic run pr-review adversarial-review --base 3f9c2e1 --brief .scratch/intent.md --file .scratch/round1-findings.md
```

### Call site 2: the audit lane in `ship` and `autopilot-full`

The coordinator runs the same command against the pull request's head and base SHAs, which it has fetched:

```sh
agentic run pr-review adversarial-review --base "$BASE_SHA" --head "$HEAD_SHA" --brief "$ROUND_DIR/intent.md"
```

The fresh verifier (live and regression lanes) stays a native `Agent(build)` child: it records a verdict in
the ledger, which lives in the real repository, so it cannot be sealed, and it is risky work by definition
(verification policy).

### Call site 3: a routine build

```sh
agentic run build --brief .scratch/rename-flag.md
```

```
build  done  lithosai/deepseek-ai/DeepSeek-V4.1-Flash (high), pace over  branch agent/run/build-9b1d0aa-5e2f7c10 (+2 commits)  run build-9b1d0aa-5e2f7c10
```

With pace `under` the same call prints `claude-opus-5-5 (medium), pace under` and still returns a branch:
the parent's workflow does not change with the quota, only the model does. The parent integrates the branch
(`git merge --ff-only agent/run/build-9b1d0aa-5e2f7c10` in its worktree) and reviews it as its own child's
work. Risky work, and work that must happen in the parent's own checkout, keeps using `Agent(build)`, which
is unchanged.

### Call site 4: a design or transcript review

```sh
agentic run review --brief .scratch/judge-brief.md --file docs/design/sealed-runs.md --file ~/.claude/projects/x/abc.jsonl
```

Each `--file` is copied into the run's inputs; the reviewer also gets a runnable clone of `HEAD`.

### Failure, as the caller sees it

```
adversarial-review  unavailable  provider overloaded (429 provider_overloaded) on 3 of 3 attempts; nothing ran in its place  run adversarial-review-3f9c2e1-c04d9e11
```

The parent reports that the adversarial review could not run, as the instructions already require ("If a
required review cannot run, say so"). Rerunning the same command later retries; a finished role in the same
command is reused, not rerun.

### Instruction text (the role line in `claude/CLAUDE.md` and `pi/AGENTS.md`)

> Launch children by role, never by naming a model: `Explore` for read-only lookups, `quick` for small
> decided edits, `bulk` for mechanical edits across many files, `build` for implementation, diagnosis, and
> verification that runs the product, `autopilot-owner` for autopilot-full owners; `general-purpose` only
> catches a launch that names no role. Reviews run sealed through `agentic run`: `review` for other review by
> a child that did not write the change, and for every pull request `pr-review` and `adversarial-review`
> together in one call. Routine `build` work that can come back as a branch also runs through
> `agentic run build`, which picks the model from the week's quota pace; risky work (security, verification
> policy, concurrency, data formats) and work in your own checkout use the `build` agent. Each role fixes
> its model and effort; pass neither. Report an unavailable role or model instead of substituting another.

## Shape

### 1. One file per role, two directories by launch kind

The binding stays where agent-kit already keeps it: one Markdown file per role, model and effort in the
frontmatter, the charter as the body. The directory says how the role launches.

| Directory | Launched by | Roles |
| --- | --- | --- |
| `claude/agents/` | Claude Code's Agent tool (linked into `~/.claude/agents/`, unchanged) | `Explore`, `quick`, `bulk`, `build`, `autopilot-owner`, `general-purpose` |
| `roles/` (new) | `agentic run` only; never linked, so no harness loads them natively | `review`, `pr-review`, `adversarial-review` |

`review` and `pr-review` move from `claude/agents/` to `roles/`. `build` stays native and gains two
namespaced keys that only `agentic run` reads:

```markdown
---
name: build
description: "..."
model: claude-opus-5-5
effort: medium
disallowedTools: Agent
agentic-access: build
agentic-overflow: lithosai/deepseek-ai/DeepSeek-V4.1-Flash high
---
```

```markdown
---
name: adversarial-review
description: "Adversarial review of a pull request on a second model family, run sealed: it can run the tests and probes but cannot edit the code under review."
model: lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017
effort: max
access: inspect
reads: skills/git-workflow/references/pr-review.md, skills/code-design/SKILL.md
---

Follow the review procedure in inputs/procedure/pr-review.md ... (shared text with pr-review; see below)
```

The engine is derived from the model string, so it cannot disagree with it: `claude-*` runs on Claude Code,
`<provider>/<id>` runs on Pi. `effort` means Claude Code's effort or Pi's thinking level, checked against the
engine's own vocabulary. The loader (`agentic/tools/roles/registry.ts`) is the one reader: it reads both
directories, refuses a name that appears in both, and answers "what does role X run on" for `agentic roles
show`, `agentic run`, and `scripts/check-skills.ts`. The check's model allowlist moves into the loader and
gains the two LithosAI IDs; its prose check (no model IDs in instructions or skills) extends to `lithosai/`
and `deepseek-` strings.

`pr-review` and `adversarial-review` run the same procedure on different model families. Their bodies are
short pointers to `git-workflow`'s `pr-review.md` (the Reviewer brief is already the method), with one
added line each: run the tests, and try at least one probe that would break the change. The `reviewed by`
instruction leaves both charters, because the launcher writes that line.

### 2. The sealed run lifecycle

```
agentic run <roles> --brief F [--base B] [--head H] [--file P]...
  parse + validate (boundary)          roles exist and are sealable; revs resolve to SHAs; files readable
  for each role, concurrently, bounded by machine-wide slots:
    key = hash(role file bytes, head, base, brief, files, procedure)       -> run id
    record dir <git-common-dir>/agentic/runs/<id>/ ; take its lock (or wait on the live holder)
    result.json says done?            -> return it (rerun after a crash is free)
    choose binding                     primary, or overflow when role has one and pace is over/exhausted
    preflight                          engine present; model in the provider's catalog -> else unavailable
    attempt 1..3:
      prepare fresh scratch            ~/.cache/agentic/runs/<id>/{tree,inputs,tmp,agent}
                                       tree = git clone --shared --no-checkout + checkout --detach <head>
                                       inputs = brief, diff.patch (base..head), --file copies, procedure copies
      exec engine under its boundary   timeout, own process group, nice
      classify output                  ok | overloaded | network | limit | auth | substituted | timeout | crash ...
      ok -> break; retryable -> sleep 30s, 120s; else stop
    review roles: parse verdict line; prepend "reviewed by <ran model> (<effort>), run <id>"
    build role:   commit leftovers in tree; refuse export if a Pi-built diff touches a risky path;
                  write report, then fetch tree HEAD into refs/heads/agent/run/<id>
    write result.json (tmp + rename), delete scratch, release lock
  print one line per role; exit with the worst status
```

### 3. The boundary per engine

The invariant both engines meet: the child's shell can write only inside its own scratch directory (and,
for Claude, the per-user temporary directory its sandbox always allows); no tool can write the real
checkout, the real `.git`, or the run record; and no credential file other than the engine's own model key
is readable.

**Pi** (`adversarial-review`, overflow `build`). The launcher wraps the whole Pi process. On macOS:
`sandbox-exec -f <profile>` with a profile that allows default, denies `file-write*`, then allows writes
to the scratch directory, `/dev/null`, `/dev/fd`, and ttys, and denies reads of `~/.ssh`, `~/.config/gh`,
`~/.aws`, `~/.netrc`, Pi's real agent directory, and the keychain's `com.apple.SecurityServer` mach service.
On Linux: `bwrap --ro-bind / / --bind <scratch> <scratch> --tmpfs` over the same credential paths,
`--unshare-pid --die-with-parent`. Any other platform is refused, never run unsealed. Pi itself runs as:

```sh
PI_CODING_AGENT_DIR=<scratch>/agent LITHOSAI_API_KEY=<from pi auth print-api-key, outside the sandbox> TMPDIR=<scratch>/tmp \
pi -p --mode json --model lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017 --thinking max \
   --session-dir <scratch>/session \     # moved into the record as evidence when the run ends
   --tools read,bash,grep,find,ls \      # build access adds edit,write
   --no-extensions -e <kit>/pi/extensions/lithosai.ts --no-skills --no-prompt-templates --no-mcp --no-approve \
   --append-system-prompt <inputs/charter.md> @inputs/brief.md
```

`--no-approve` ignores project-local files in the tree, so a pull request cannot add a Pi extension that
runs in the reviewer. The fresh agent directory is required: probed on this machine, Pi under a write-deny
profile fails on `EPERM ... mkdir .../agent/auth.json.lock` when its agent directory is the real one, and
starts when `PI_CODING_AGENT_DIR` points into the scratch directory and the key comes from the environment.

**Claude Code** (`pr-review`, `review`, `build` when not overflowing). The Claude process cannot be wrapped
in `sandbox-exec` without losing its keychain login and its writes under `~/.claude`, so the launcher uses
Claude Code's own boundaries, all set per process:

```sh
cd <scratch>/tree && TMPDIR=<scratch>/tmp claude -p --output-format json \
  --model claude-opus-5-5 --effort xhigh \
  --restricted --tools Read,Grep,Glob,Bash \                 # build access adds Edit,Write
  --settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true}}' \
  --permission-mode dontAsk --permission-prompts none \      # build access: acceptEdits
  --strict-mcp-config --add-dir <scratch>/inputs \
  --append-system-prompt "$(cat <scratch>/inputs/charter.md)" < <scratch>/inputs/brief.md
```

Bash runs under Seatbelt or bubblewrap and can write only the tree, the inputs, and temp. `--restricted`
confines the file tools to the working directories and ignores user, project, and local settings files, so a
pull request's `.claude/settings.json` hooks never run in the reviewer, and `--strict-mcp-config` drops its
`.mcp.json`. Edit and Write do not exist in a reviewer's process. No `--fallback-model` is ever passed.

The two adapters differ, so one conformance script defines the boundary for both (First implementation
step): inside the child, `bun test` in the tree passes; writing the real checkout, the real `.git`, another
run's scratch, or `~/.ssh` fails; `git push` from the tree fails.

### 4. Choosing the model

```
choose(role, pace):
  role has no overflow binding        -> primary
  pace under | unknown                -> primary            ("unknown": the pace command failed or printed anything else)
  pace over                           -> overflow
  pace exhausted                      -> overflow
```

Only `build` has an overflow binding, and only `agentic run build` consults the pace; the parent never runs
`agentic quota pace` itself. Risk is the parent's call, made by choosing the launch: risky work goes to
`Agent(build)`, which is Claude by construction. As a backstop, an overflow run whose diff touches a risky
path (verify's `POLICY_PATHS` plus a `RISKY_PATHS` list in the same module) is refused: the report is kept,
the branch is not exported, and the parent is told to rerun it as `Agent(build)`.

A reviewer's binding never changes with the pace. If Claude's quota is exhausted, `pr-review` fails with a
`limit` failure and is reported unavailable, while `adversarial-review` still runs.

### 5. Data structures and the access patterns through them

| Structure | Where | Shape |
| --- | --- | --- |
| Role registry | `claude/agents/*.md`, `roles/*.md`, loaded per invocation | `Map<RoleName, Role>`, `Role` a union by launch kind |
| Run record | `<git-common-dir>/agentic/runs/<id>/` | `lock/` (pid, start), `attempts.jsonl` (append-only), `report.md`, `result.json` (terminal, versioned), `engine.log` (stderr tail), `session/` (Pi transcript) |
| Scratch | `~/.cache/agentic/runs/<id>/` | `tree/` (shared clone at head), `inputs/`, `tmp/`, `agent/` (Pi config dir), `session/` |
| Slots | `~/.cache/agentic/slots/slot-<n>` | one file per running run, created with `O_EXCL`, holds the pid |

The run id is `<role>-<head 7>-<first 8 hex of sha256(canonical inputs)>`. The canonical inputs are the role
file's bytes, head, base, the brief's bytes, each `--file`'s bytes, and each `reads` file's bytes. The chosen
binding is not in the key, so a rerun after the pace flips still finds the finished result.

Traces:

- **Review a pull request (two roles).** Parse, then two `runOne` in parallel. Each takes a slot, hashes to
  its own id, so the two never share a record dir or scratch. Each clones from the real repository with
  `--shared`: the clone's `objects/info/alternates` points at the real object store, which both children
  only read (the OS boundary denies writes there). Wall time is the slower review, about 7 minutes.
- **Rerun after the parent was killed.** Same command, same ids. A role whose `result.json` says `done`
  returns at once. A role whose lock names a dead pid is reclaimed: unless an `ok` attempt is pending (section
  7), the stale scratch is deleted and a fresh attempt starts. `interrupted` attempts do not count against the
  retry budget.
- **Cite the result.** The parent pastes the printed `reviewed by ... run <id>` line. `agentic run show
  <id>` reads `result.json` and `report.md`. The pull request body carries only the model and run id, never
  a local path (the repository is public).
- **Overflow build.** `choose` reads the pace once. The child commits in its clone; new objects land in the
  clone's own object store. Export is one `git fetch <scratch>/tree HEAD:refs/heads/agent/run/<id>` run by
  the launcher, outside the sandbox.
- **Cleanup.** Scratch is deleted when a run ends, success or not. `agentic run gc` (also run at the start
  of every invocation, bounded to a directory listing) deletes scratch whose lock holder is dead and records
  older than 30 days.

### 6. Shared state and its single writers

| State | Writer | Everyone else |
| --- | --- | --- |
| The parent's checkout and working tree | the parent | sealed children never see it; they work in a clone |
| Real object store and refs | the launcher, only to create `refs/heads/agent/run/<id>` | children read objects through alternates; the OS denies writes |
| Run record `<id>` | the launcher holding `<id>`'s lock | `show`, the parent, reading |
| Scratch `<id>` | that run's engine and its launcher | no other child can write it (Pi: profile; Claude: not in its write set) |
| Slots | each launcher, by `O_EXCL` create and delete | none |
| Quota pace | `agentic quota pace` (built separately) | the launcher reads it |

Two invocations of the same run id are serialized by the lock: the second waits for the first and returns
its result instead of starting a second child. Two different runs share nothing writable. The one writer of
the real repository is the launcher, and it only ever creates a new, uniquely named ref; it never moves or
deletes one. A pull request's reviewers therefore cannot disturb each other, the parent, or the branch they
review.

### 7. Repeatability, crash points, and bounds

| Crash or repeat point | What happens on rerun |
| --- | --- |
| Before the lock | nothing was written; starts normally |
| During prepare or engine run | dead pid in the lock: reclaim, delete scratch, new attempt |
| After the engine exits, before its `ok` attempt is appended | same as above: a fresh attempt |
| After the `ok` attempt and `report.md`, before `result.json` | the reclaim sees a pending `ok`: inspect writes `result.json`; build exports if the ref is missing and the tree is still there, then writes `result.json`. Only when the tree is gone does it start a fresh attempt |
| Build: after export, before `result.json` | the ref exists: `result.json` is written from it without running the child |
| After `result.json` `done` | returned as is |
| After `result.json` `unavailable` or `refused` | replaced by a new set of attempts: a rerun is how the caller retries later |
| Same command run twice concurrently | second waits on the lock and returns the first's result |

Bounds: at most 3 attempts per invocation, retrying only `overloaded` and `network` failures, after 30 s
and 120 s. A `limit`, `auth`, `model-unknown`, `sandbox-unavailable`, or `substituted` failure stops at once.
Per-attempt timeout by access: 25 minutes for `inspect` (benchmark reviews took 4 to 8), 60 minutes for
`build`; on timeout the process group gets SIGTERM, then SIGKILL after 10 s. At most 4 sealed runs at a time
per machine; extra runs wait for a slot and say so on stderr. A run refuses to start with less than 2 GB free
on the scratch volume.

### 8. Types and signatures

The CLI flags and the printed lines are the public surface. `result.json` is a storage type: only
`encodeResult` writes it and only `decodeResult` reads it.

```ts
// agentic/tools/roles/registry.ts: the one reader of role files

export type RoleName = string & { readonly __brand: "RoleName" }; // minted only by parseRole

export const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-opus-5-5"] as const;
export const PI_MODELS = [
	"lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017",
	"lithosai/deepseek-ai/DeepSeek-V4.1-Flash",
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export type PiModel = (typeof PI_MODELS)[number];
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type PiThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeBinding = { readonly engine: "claude"; readonly model: ClaudeModel; readonly effort: ClaudeEffort };
export type PiBinding = { readonly engine: "pi"; readonly model: PiModel; readonly thinking: PiThinking };
export type Binding = ClaudeBinding | PiBinding;

/** What a sealed child's process may do. Tool lists and sandbox write sets derive from this alone. */
export type Access = "inspect" | "build";

interface RoleCommon {
	readonly name: RoleName;
	readonly description: string;
	readonly charter: string;
	readonly file: string; // repository-relative, for error messages and the run key
}

/** In claude/agents/, launched only by the Agent tool. */
export interface NativeRole extends RoleCommon {
	readonly kind: "native";
	readonly binding: ClaudeBinding;
}

/** In roles/, launched only by agentic run. */
export interface SealedRole extends RoleCommon {
	readonly kind: "sealed";
	readonly binding: Binding;
	readonly access: Access;
	readonly reads: readonly string[]; // kit-relative files copied into inputs/procedure/
}

/** In claude/agents/ with agentic-access: build. Native on Claude; sealed with an optional overflow. */
export interface NativeAndSealedRole extends RoleCommon {
	readonly kind: "native-and-sealed";
	readonly binding: ClaudeBinding;
	readonly access: "build";
	readonly overflow: PiBinding | null;
	readonly reads: readonly string[];
}

export type Role = NativeRole | SealedRole | NativeAndSealedRole;
export type Sealable = SealedRole | NativeAndSealedRole;

export interface Registry {
	readonly roles: ReadonlyMap<RoleName, Role>;
}

/** Throws naming the file and the field: unknown key, model not in the engine's list, effort not in its vocabulary. */
export function parseRole(file: string, text: string, kind: "native-dir" | "sealed-dir"): Role {
	throw new Error("not implemented");
}

/** Reads both directories; throws on a name defined twice. */
export function loadRegistry(kitRoot: string): Registry {
	throw new Error("not implemented");
}

/** Narrows a CLI argument; the error names the launch path for a native-only role. */
export function sealable(registry: Registry, name: string): Sealable {
	throw new Error("not implemented");
}
```

```ts
// agentic/tools/run/plan.ts: pure decisions, no I/O

export type Sha = string & { readonly __brand: "Sha" }; // 40 hex, resolved at the boundary
export type RunId = string & { readonly __brand: "RunId" };
export type AbsPath = string & { readonly __brand: "AbsPath" };
export type Pace = "under" | "over" | "exhausted" | "unknown";

export interface InputFile { readonly name: string; readonly bytes: Uint8Array }

export interface RunInputs {
	readonly role: Sealable;
	readonly roleBytes: Uint8Array;
	readonly head: Sha;
	readonly base: Sha | null;
	readonly brief: Uint8Array;
	readonly files: readonly InputFile[];
	readonly procedure: readonly InputFile[]; // the role's reads, from the installed kit
}

export interface Choice {
	readonly binding: Binding;
	readonly why: "primary" | "pace over" | "pace exhausted";
	readonly pace: Pace | null; // null when the role has no overflow, so the pace was not read
}

export interface Host {
	readonly platform: "darwin" | "linux";
	readonly home: AbsPath;
	readonly kitRoot: AbsPath;
	readonly recordRoot: AbsPath; // <git-common-dir>/agentic/runs
	readonly scratchRoot: AbsPath; // ~/.cache/agentic/runs
}

export interface Workspace {
	readonly id: RunId;
	readonly record: AbsPath;
	readonly scratch: AbsPath;
	readonly tree: AbsPath;
	readonly inputs: AbsPath;
	readonly tmp: AbsPath;
	readonly agentDir: AbsPath; // Pi only
	readonly session: AbsPath;
}

export interface Command {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>; // the full environment; nothing is inherited implicitly
	readonly cwd: AbsPath;
	readonly timeoutMs: number;
	readonly stdin: AbsPath | null;
}

export function runId(inputs: RunInputs): RunId {
	throw new Error("not implemented");
}

export function choose(role: Sealable, pace: Pace | null): Choice {
	throw new Error("not implemented");
}

export function workspaceFor(id: RunId, host: Host): Workspace {
	throw new Error("not implemented");
}

/** The engine command with its boundary applied. The only place tool lists and sandbox settings are spelled. */
export function engineCommand(role: Sealable, choice: Choice, ws: Workspace, host: Host, secretEnv: Readonly<Record<string, string>>): Command {
	throw new Error("not implemented");
}

/** sandbox-exec or bwrap around argv. Throws on any other platform: there is no unsealed path. */
export function sealedArgv(host: Host, ws: Workspace, argv: readonly string[]): readonly string[] {
	throw new Error("not implemented");
}

export function seatbeltProfile(ws: Workspace, host: Host): string {
	throw new Error("not implemented");
}

/** Changed paths an overflow run may not touch: verify's POLICY_PATHS plus RISKY_PATHS. */
export function riskyPaths(changed: readonly string[]): readonly string[] {
	throw new Error("not implemented");
}
```

```ts
// agentic/tools/run/outcome.ts: pure interpretation of what an engine did

export type Failure =
	| { readonly kind: "overloaded"; readonly detail: string } // 429 provider_overloaded, 529: retried
	| { readonly kind: "network"; readonly detail: string } // reset, DNS, TLS: retried
	| { readonly kind: "limit"; readonly detail: string } // subscription or usage limit
	| { readonly kind: "auth"; readonly detail: string }
	| { readonly kind: "model-unknown"; readonly model: string } // not in the provider's catalog
	| { readonly kind: "sandbox-unavailable"; readonly detail: string } // e.g. a sandboxed parent
	| { readonly kind: "substituted"; readonly wanted: string; readonly ran: string }
	| { readonly kind: "timeout"; readonly afterMs: number }
	| { readonly kind: "interrupted" } // the launcher was signalled; not charged to the budget
	| { readonly kind: "crash"; readonly exit: number; readonly tail: string };

export interface EngineOutput {
	readonly exit: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderrTail: string;
	readonly timedOut: boolean;
}

export type Parsed =
	| { readonly ok: true; readonly report: string; readonly ranModel: string }
	| { readonly ok: false; readonly failure: Failure };

export type Verdict = "PASS" | "PASS+NOTES" | "FAIL";

export interface Attempt {
	readonly n: number;
	readonly startedAt: string;
	readonly endedAt: string;
	readonly outcome: "ok" | Failure;
}

export interface Branch { readonly ref: string; readonly sha: Sha; readonly commits: number }

export type Result =
	| {
			readonly status: "done";
			readonly run: RunId;
			readonly role: RoleName;
			readonly ran: Binding;
			readonly why: Choice["why"];
			readonly reviewedBy: string; // "reviewed by <model> (<effort>), run <id>"
			readonly verdict: Verdict | null; // null for build
			readonly branch: Branch | null; // null for inspect
			readonly attempts: readonly Attempt[];
	  }
	| {
			readonly status: "unavailable";
			readonly run: RunId;
			readonly role: RoleName;
			readonly wanted: Binding;
			readonly failure: Failure;
			readonly attempts: readonly Attempt[];
	  }
	| {
			readonly status: "refused";
			readonly run: RunId;
			readonly role: RoleName;
			readonly reason: string; // names the fix: "commit first", "touches agentic/tools/verify/; rerun as Agent(build)"
			readonly attempts: readonly Attempt[];
	  };

/** Claude: --output-format json; Pi: --mode json events. The model that ran comes from here, never from the report. */
export function parseEngineOutput(wanted: Binding, out: EngineOutput): Parsed {
	throw new Error("not implemented");
}

/** Milliseconds to wait before the next attempt, or null to stop. Exhaustive over Failure. */
export function retryDelay(failure: Failure, attemptsCharged: number): number | null {
	throw new Error("not implemented");
}

/** The first `verdict:` line; null when the report has none (the run is done, the parent judges the raw report). */
export function reviewVerdict(report: string): Verdict | null {
	throw new Error("not implemented");
}

export function encodeResult(result: Result): string {
	throw new Error("not implemented"); // {"version":1, ...}
}

export function decodeResult(text: string): Result {
	throw new Error("not implemented"); // throws on an unknown version or shape
}
```

```ts
// agentic/tools/run/run.ts: the orchestration; every effect goes through Shell

export interface Lock { release(): Promise<void> }

export interface Shell {
	pace(): Promise<Pace>; // runs `agentic quota pace`; anything but under|over|exhausted is "unknown"
	preflight(binding: Binding): Promise<Failure | null>; // engine on PATH; model listed by the provider
	secretEnv(binding: Binding): Promise<Readonly<Record<string, string>>>; // Pi: the provider key, read outside the sandbox
	slot(): Promise<Lock>; // waits for one of the machine-wide slots
	lock(ws: Workspace): Promise<Lock>; // waits on a live holder; reclaims a dead one
	readResult(ws: Workspace): Promise<Result | null>;
	prepare(ws: Workspace, inputs: RunInputs): Promise<void>; // fresh scratch every attempt
	exec(command: Command): Promise<EngineOutput>;
	changedPaths(ws: Workspace, base: Sha): Promise<readonly string[]>;
	exportBranch(ws: Workspace): Promise<Branch | null>; // creates refs/heads/agent/run/<id>; never moves a ref
	append(ws: Workspace, attempt: Attempt): Promise<void>;
	write(ws: Workspace, name: "report.md" | "result.json", text: string): Promise<void>; // tmp + rename
	clearScratch(ws: Workspace): Promise<void>;
	sleep(ms: number): Promise<void>;
}

export async function runOne(inputs: RunInputs, host: Host, shell: Shell): Promise<Result> {
	throw new Error("not implemented");
}

/** Runs every role concurrently; each holds a slot while it runs. */
export async function runAll(inputs: readonly RunInputs[], host: Host, shell: Shell): Promise<readonly Result[]> {
	throw new Error("not implemented");
}
```

```ts
// agentic/tools/run/cli.ts
//   agentic run <role>... --brief <file> [--base <rev>] [--head <rev>] [--file <path>]...
//   agentic run show <run id>
//   agentic run gc
// Validates at the boundary (roles sealable, revs resolve to SHAs, head is a commit and, when --head is
// omitted, the worktree's tracked files match it), then trusts the types.
export async function main(args: readonly string[]): Promise<number> {
	throw new Error("not implemented");
}
```

The call chain is three deep: `cli.main` to `runAll` to `runOne`, which calls the pure functions and the
`Shell`. Tests drive `runOne` with a fake `Shell` and engine-output fixtures; the real shell is covered by the
conformance script.

### 9. Module map

```
agent-kit/
  roles/                                   sealed roles, one file each (new; never linked into a harness)
    review.md, pr-review.md, adversarial-review.md
    README.md                              add or change a sealed role; why these are not Claude agents
  claude/agents/
    build.md                               + agentic-access: build, agentic-overflow
    review.md, pr-review.md                removed (moved to roles/)
  agentic/tools/roles/
    registry.ts, registry.test.ts          parse and load both directories; the model and effort lists
    cli.ts                                 agentic roles show | check
  agentic/tools/run/
    plan.ts, plan.test.ts                  run id, choose, workspace paths, engine commands, sandbox profiles, risky paths
    outcome.ts, outcome.test.ts            engine output, failures, retry, verdict, result encoding
    run.ts, run.test.ts                    runOne, runAll over a Shell; fake-shell tests of every crash row
    shell.ts                               the real Shell: git, spawn with process groups, locks, slots, gc
    cli.ts                                 agentic run | show | gc
    conformance.sh                         the boundary contract both engines must meet
    fixtures/                              recorded engine outputs: Claude ok and usage limit, Pi ok and 429 provider_overloaded
  agentic/tools/verify/verify.ts           POLICY_PATHS imported by riskyPaths (unchanged)
  agentic/bin/agentic                      + roles, run
  scripts/check-skills.ts                  role checks call the registry; prose check gains lithosai/ and deepseek-
  scripts/validate                         + agentic roles check
  claude/CLAUDE.md, pi/AGENTS.md           the role line above
  skills/git-workflow/references/pr-review.md         step 4: one agentic run call for both reviewers
  skills/babysit-and-ship/references/{shipping,autopilot-full,pr-body}.md   audit lane; one review-record line per reviewer
  README.md, claude/README.md              install contract: Pi honours an explicit PI_CODING_AGENT_DIR; agentic run must not run inside a parent's Bash sandbox
  docs/adr/NNNN-sealed-runs.md             the boundary, the result format, the single writer
  docs/design/model-roles.md               T3 targets for these roles superseded
```

## Tradeoffs accepted

- **Routine builds come back as branches, at every pace.** The parent merges a branch instead of seeing edits
  appear in its checkout. In exchange, the parent's workflow is the same whether the quota is under or over,
  a DeepSeek builder can touch nothing but its clone, two builders can never write one checkout, and a
  retry after a crash starts clean.
- **Every sealed run pays startup**: a shared clone (cheap: objects come through alternates), a checkout,
  and usually a dependency install inside the clone, perhaps 30 seconds to 2 minutes, on top of 4 to 8
  minutes of review. In-session reviewers paid none of this. Seeding `node_modules` by copy-on-write clone
  when the lockfile matches is a later optimization, not part of this design.
- **Two enforcement adapters, one contract.** Pi is wrapped whole by the OS. Claude's shell is sandboxed by
  the OS, but its file tools are confined by Claude Code's `--restricted` mode, which is the harness, not the
  kernel. The shared conformance script is what keeps them equivalent.
- **Network stays open for Pi children.** Seatbelt cannot filter by host, and the child needs LithosAI and
  package registries. No credential except its own model key is readable, the clone's only remote is a local
  path, and the code is already being sent to that provider, so the residual risk is the reviewer reading its
  own API key.
- **Reviewers stop being Claude Code agent types.** `Agent(subagent_type: "pr-review")` no longer exists; the
  name lives on as `agentic run pr-review`. Every caller is in agent-kit's own skills and instructions, and
  the migration changes them in the same pull request.
- **A finished run with identical inputs is reused, not rerun.** A deliberate second opinion on the same
  head and brief needs a changed brief. Reuse is what makes a crash-rerun free.
- **macOS and Linux only.** Elsewhere `agentic run` refuses.
- **A small persisted format**, `result.json` version 1, read only by `agentic run show` and the launcher.

## Alternatives considered

- **In-session subagents with Bash plus a deny hook.** A `PreToolUse` hook that pattern-matches shell
  commands cannot stop `python -c`, `sed -i`, or a test that writes files; and the session-wide sandbox cannot
  be narrowed for one child. Not a boundary.
- **T3 `delegate_task` to a Pi or Claude child** (what `model-roles.md` planned). Needs T3, so a plain
  terminal session cannot review; the child inherits the parent's working directory with no sandbox. Fails
  both the boundary and the works-without-T3 requirement. This design supersedes those T3 targets for these
  roles.
- **`git worktree add` for the reviewer's copy.** A worktree must write the shared `.git` (its index, `HEAD`,
  refs), so the sandbox would have to allow writes where branches live. A `--shared` clone keeps the real
  `.git` read-only and still gives reviewers `git log` and `git diff`.
- **`git archive` of the head** (the benchmark's method). Exact and safe, but no history: a reviewer cannot
  run `git diff base`. The shared clone costs about the same.
- **A copy-on-write copy of the checkout.** Carries uncommitted and ignored state, so it is not the exact
  head, and it is macOS-only.
- **A container per run.** The strongest isolation, but it needs a daemon and an image with every
  repository's toolchain. Worth revisiting if network filtering becomes a requirement.
- **Wrapping Claude Code itself in `sandbox-exec`.** Breaks the keychain login and its writes under
  `~/.claude`; Claude Code's own sandbox already covers its shell.
- **The parent decides the overflow** (runs `agentic quota pace`, then picks a launch). Two calls, and the
  decision lives in prose that a parent can skip. The launcher decides instead.
- **A renderer that generates `claude/agents/` from one `roles/` tree.** One directory instead of two, but
  generated files, a drift check, and a renderer for six files whose format is already the runtime's.
  Directory-by-launch-kind with a loader that refuses duplicates gives one file per role without it.
- **Automatic tier fallback** (Ultra to Base on 429). A silent substitution. The binding names the tier, and
  the evidence says Base stays up.

## Open questions and risks

Questions for the user:

1. **The adversarial reviewer's model ID.** `pi --list-models lithosai` on this machine lists
   `DeepSeek-V4.1-Flash-0910` and the undated `DeepSeek-V4.1-Flash` (each with `-fast` and `-ultra`), and no
   `-1017`. Options: (a) bind `lithosai/deepseek-ai/DeepSeek-V4.1-Flash-1017` and let preflight report it
   unavailable until the catalog lists it; (b) bind the undated alias, which can change under us. Recommend
   (a): a review record should name a model that stays the same. Default: (a), on the Base tier, because
   Ultra was the tier that returned 429 for long stretches; `-fast` is the alternative if 7-minute reviews are
   too slow.
2. **Routine Claude builds go sealed too.** Recommended above, so the workflow does not flip with the pace.
   The alternative is `agentic run build` exiting with "pace under: use Agent(build)", which keeps today's
   in-place builds but makes the parent's path depend on the quota. Default: sealed at every pace.
3. **Retry budget.** Three attempts at 30 s and 120 s fits a review lane of under 30 minutes. Ten of twelve
   Ultra reviews died mid-run in the benchmark; on Base that rate is unmeasured. Default: 3.

Risks to verify while building:

- **Claude flags together.** That `--restricted` with `--settings` sandbox, `--tools`, `dontAsk`, and
  `--permission-prompts none` lets sandboxed Bash run without a prompt, keeps Read able to reach `inputs/`
  through `--add-dir`, and refuses writes outside the tree. The conformance script checks each.
- **A sandboxed parent.** None of this machine's settings enable Claude Code's sandbox today. A parent that
  does would nest sandboxes, which fails; `failIfUnavailable` and the Pi wrapper make that a reported
  `sandbox-unavailable`, never an unsealed run. The install contract asks for `agentic run` in the parent's
  `sandbox.excludedCommands`, which is a permission change the user makes.
- **This machine's `pi` wrapper resets `PI_CODING_AGENT_DIR`** to the private agent directory before
  starting Pi (probed: the scratch value was ignored until Pi's CLI was started directly). The install
  contract must say the wrapper keeps a value that is already set; that change belongs to the installer's
  repository.
- **Engine output fields.** Which field carries the model that ran: Claude's `modelUsage` keys (it also uses
  Haiku for internal work, so the rule is the model with the most output tokens), and the model on Pi's
  assistant-message events. Fixtures pin both.
- **Claude's per-user temp allowance.** If Claude's sandbox allows the whole per-user temp directory rather
  than `$TMPDIR` as set, other runs' scratch is still safe, because scratch lives under `~/.cache`, not temp.
- **Tests that need services or fixed ports.** Two reviewers running one suite in parallel can collide on a
  port. Per-run `TMPDIR` covers files, not ports; a repository whose tests bind fixed ports needs its
  verification skill to say so.

## First implementation step

Build the boundary before anything that uses it. On `agent/sealed-runs`:

1. `agentic/tools/run/plan.ts` with `workspaceFor`, `seatbeltProfile`, `sealedArgv`, and `engineCommand` for
   both engines, plus `shell.ts`'s `prepare` (shared clone at head, inputs) and `clearScratch`.
2. `conformance.sh`, run inside the sealed child, which must print exactly these results:
   `bun test` in the tree passes; `touch <real checkout>/x` fails; `touch <real .git>/x` fails;
   `touch <another run's scratch>/x` fails; `cat ~/.ssh/config` fails; `git -C tree push` fails.
3. A test, `plan.test.ts`'s `sealed boundary`, that runs `conformance.sh` through `sealedArgv` directly (the
   exact wrapper Pi gets, with `/bin/sh` in place of Pi, so it is deterministic and costs no model call),
   and a manual run of the Claude adapter with a fixed prompt ("run `sh inputs/conformance.sh` and print its
   output") on `claude-haiku-5-5`, since the boundary does not depend on the model.

It is done when both adapters produce the expected conformance output on macOS against agent-kit itself,
and the Pi wrapper's on Linux in CI. Then, in order: `outcome.ts` with the recorded fixtures; `runOne` with
locks, attempts, and results; the three role files and the registry; `agentic run build` with the pace and
export; the instruction and skill wording; and the ADR.
