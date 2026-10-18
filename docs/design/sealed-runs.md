# Sealed runs: reviewers that can run code, a second model family, and overflow builds

- **Status:** proposed 2026-10-18, waiting for the user's review of the shape. Nothing here is built.
- **Reader:** the user, then whoever builds it.
- **Method:** `design-checkpoint`. Two candidates were written independently from the same task and grounding:
  [candidate A](sealed-runs/candidate-a.md) and [candidate B](sealed-runs/candidate-b.md). They converged on
  the same whole shape, which this document adopts with B as the base.

## The door

Three things here are hard to reverse:

1. **A security boundary.** Reviewers gain a shell. "They cannot edit the code under review" must hold by an
   OS or process boundary, not by instruction.
2. **A process boundary and new contracts.** Reviews and overflow builds run as separate headless processes
   launched by a new `agentic run` command. Its arguments, its run record under the git common directory, and
   the `reviewed by` line it writes become contracts that skills, the Review record, and `correct` read.
3. **Role names and where roles live.** `adversarial-review` is added, and `pr-review` moves out of
   `claude/agents/` into a directory only `agentic run` loads, so it is no longer an Agent-tool type.

Reversible work around it: the model and effort each role gets, retry counts, timeouts, and wording.

## Problem

The 2026-10-18 benchmark showed reviewers that could run the change found a hook-skip bypass a read-only
reviewer missed, and that a second model family (DeepSeek V4.1 Flash on LithosAI, through Pi) reviews as well
as Opus for a fraction of the cost. The user decided: every pull request gets `pr-review` (Opus `xhigh`) and
`adversarial-review` (Flash `max`) in parallel; reviewers may run tests and probes but must not be able to
edit; subagents are no longer Claude-only; routine `build` work runs on Flash `high` when the week's Claude
quota is ahead of pace (`agentic quota pace`), and risky work stays on Claude.

What makes the shape non-obvious:

- Claude Code's Bash sandbox is OS-enforced but per session: an in-session subagent cannot be stricter than
  its parent. A reviewer that runs code but cannot edit has to be its own process.
- A Claude Code session can only run Claude models as subagents. Pi runs Flash, and has no sandbox of its own.
- T3 `delegate_task` can reach Pi, but only from inside T3, and its children share the parent's workspace
  with no boundary.
- LithosAI Ultra returned `429 provider_overloaded` for long stretches; a reviewer can die mid-run.

## Usage (caller's view)

Both pull-request reviewers, in parallel, in one call that blocks until both finish (a Claude Code parent runs
it with Bash's `run_in_background` and is woken on exit):

```sh
agentic run pr-review adversarial-review --base "$(git merge-base origin/main HEAD)" --brief .scratch/intent.md
```

```
pr-review           done  FAIL        reviewed by claude-opus-5-5 (xhigh), run pr-review-3f9c2e1-a71b40c2       7m12s
adversarial-review  done  PASS+NOTES  reviewed by lithosai/deepseek-ai/DeepSeek-V4.1-Flash (max, build 2026-10-17), run adversarial-review-3f9c2e1-c04d9e11  6m40s
reports: agentic run show <run>
```

The parent reads each report with `agentic run show <run>`, judges the findings, and copies each
`reviewed by` line into the pull request's `## Review record`. The launcher writes that line from the model
the engine actually ran, never from the reviewer's self-report. Exit status: 0 every role finished (whatever
the verdicts), 1 a role was unavailable, 3 a run was refused, 2 a usage error. A `FAIL` verdict is a finished
review.

A focused re-review is the same call with the prior head as `--base` and the accepted findings as
`--file .scratch/round1-findings.md`. The `ship` and `autopilot-full` audit lane is the same call with the
pull request's base and head SHAs. Fresh verifiers stay native `Agent(build)` children, because they record
a verdict in the real repository's ledger.

A routine build:

```sh
agentic run build --brief .scratch/rename-flag.md
```

```
build  done  lithosai/deepseek-ai/DeepSeek-V4.1-Flash (high), pace over  branch agent/run/build-9b1d0aa-5e2f7c10 (+2 commits)
```

At pace `under` or `unknown` the same call runs Claude (`build`'s own model) and still returns a branch, so
the parent's workflow does not change with the quota, only the model does. The parent integrates the branch
(`git merge --ff-only`) and reviews it as its child's work. Risky work (security, verification policy,
concurrency, data formats) and work in the parent's own checkout use `Agent(build)`, as today.

A provider failure, as the caller sees it:

```
adversarial-review  unavailable  provider overloaded (429) on 3 of 3 attempts; nothing ran in its place  run adversarial-review-3f9c2e1-c04d9e11
```

Rerunning the same command retries; a role that already finished in that run is reused, not rerun.

Proving the boundary on a new machine or harness version (grafted from candidate A's `doctor`):

```sh
agentic run doctor     # inside each engine's boundary: tests run; writes to the real checkout, .git, ~/.ssh, and git push fail
```

## Shape

**Roles: one file per role, two directories by launch kind.** `claude/agents/` keeps the roles the Agent
tool launches (`Explore`, `quick`, `bulk`, `build`, `review`, `autopilot-owner`, `general-purpose`). A new
`roles/` directory, never linked into any harness, holds the roles only `agentic run` launches: `pr-review`
and `adversarial-review`. `build` stays native and gains two keys only `agentic run` reads
(`agentic-access: build`, `agentic-overflow: lithosai/deepseek-ai/DeepSeek-V4.1-Flash high`). The engine is
derived from the model string (`claude-*` runs on Claude Code, `<provider>/<id>` on Pi), so the two cannot
disagree. One loader (`agentic/tools/roles/registry.ts`) reads both directories, refuses a name in both, and
is what `agentic run`, `agentic roles show`, and `scripts/check-skills.ts` ask; the check's model allowlist
moves into it and gains the LithosAI IDs.

**A sealed run.** For each role, concurrently, at most four runs per machine:

1. The run ID is a hash of the role file, head, base, brief, input files, and the pinned review procedure.
   The run record is `<git-common-dir>/agentic/runs/<id>/` (lock, `attempts.jsonl`, `report.md`, terminal
   `result.json`); the launcher is its only writer. A finished record is returned as-is, so a rerun after a
   crash is free; a stale lock is reclaimed.
2. Choose the binding: the role's model, or `build`'s overflow binding when `agentic quota pace` says `over`
   or `exhausted`. A reviewer's binding never changes with the pace.
3. Preflight: the engine exists and the model is in the provider's catalog, or the run is `unavailable`.
4. Up to three attempts, retried only on overload or network errors (30 s, then 120 s), each in fresh
   scratch at `~/.cache/agentic/runs/<id>/`: a `git clone --shared` of the exact head, the brief, the diff,
   copies of `--file` inputs and of the review procedure. Each attempt has a timeout and its own process
   group. A run whose engine reports a different model than bound is `substituted`, never accepted.
5. A review parses the verdict line and gets the `reviewed by` line. A build commits leftovers, is refused
   export if an overflow (Pi) diff touches a policy or risky path, and is fetched into
   `refs/heads/agent/run/<id>`, the only write the launcher makes to the real repository.
6. Write `result.json` (temp file, then rename), delete scratch, release the lock.

**The boundary.** Invariant for both engines: the child's shell writes only its own scratch (plus, for
Claude, its per-user temp directory); no tool writes the real checkout, the real `.git`, or the run record;
no credential file but the engine's own model key is readable; `git push` fails.

- **Claude Code** (`pr-review`, Claude `build`): `claude -p --restricted --tools Read,Grep,Glob,Bash`
  (a build adds `Edit,Write`) with `--settings` turning on the sandbox with `allowUnsandboxedCommands: false`
  and `failIfUnavailable: true`, `--strict-mcp-config`, no `--fallback-model`, cwd the scratch tree.
  `--restricted` also ignores the settings files in the tree, so a pull request's `.claude/settings.json`
  hooks never run in its reviewer.
- **Pi** (`adversarial-review`, overflow `build`): the whole Pi process wrapped by the launcher in
  `sandbox-exec` (macOS) or `bwrap` (Linux) allowing writes only to scratch, with `PI_CODING_AGENT_DIR` in
  scratch, the LithosAI key passed in the environment, `--tools read,bash,grep,find,ls` (a build adds
  `edit,write`), `--no-extensions -e <kit>/pi/extensions/lithosai.ts`, and `--no-approve` so project-local
  Pi files in the tree are ignored. Any other platform is refused, never run unsealed.

## Synthesis decision

Base: candidate B. It has one writer for every piece of state (the launcher for the run record and the one
ref it exports), content-addressed runs that make a rerun after a crash free, an explicit bound on runs per
machine, and `build` choosing its own model from the pace so the parent's path never branches on quota.

Grafted from candidate A: `agentic run doctor`, a conformance command proving both engines' boundaries on
the installed harness versions, and the `substituted` outcome when the engine reports a different model than
the role binds.

Changed from both: `review` (plans, designs, transcripts) stays a native, read-only Agent-tool role. Its
inputs are files, not running code, and moving it out would add a process launch to every reflect lens,
design judge, and Attention review for no finding the benchmark showed. Only pull-request review moves.

Rejected from A: a `PreToolUse` hook on the Agent tool that reads a required `Risk:` line in every `build`
brief and blocks routine launches when the pace is over. It enforces routing, but it adds a brief format and
a hook every parent pays for; B's export refusal on risky paths catches the dangerous case at the result.

## Tradeoffs accepted

- We accept a 2-5 s process start and a fresh clone per review in exchange for a boundary the OS enforces.
- We accept that `pr-review` is no longer an Agent-tool type, in exchange for the reviewer being able to run
  the change it reviews.
- We accept that overflow builds return a branch the parent merges, rather than editing the parent's
  checkout, in exchange for every build being reviewable and the parent's workflow not changing with pace.
- We accept a second review costing a few cents and about 7 minutes per pull request, in parallel with the
  first, in exchange for a reviewer from a different model family.

## Alternatives considered

- **T3 `delegate_task` to Pi.** Reaches Flash, but only inside T3, and the child shares the parent's
  workspace with no boundary, so "cannot edit" is instruction-only. Rejected by both candidates.
- **Give in-session reviewers Bash.** Smallest change, but a session's sandbox applies to all its children,
  and a reviewer could then edit the real checkout. Rejected by both candidates.
- **Turn the sandbox on for every session.** Would also confine `build` and owners, which must push.

## Open questions

1. **Which LithosAI model ID the reviewer binds.** LithosAI's catalog lists the undated
   `deepseek-ai/DeepSeek-V4.1-Flash` (created 2026-10-17, the 1017 build) and a pinned
   `deepseek-ai/DeepSeek-V4.1-Flash-0910`; there is no `-1017` ID. Options: (a) the undated ID, with the
   launcher recording the served build's creation date from the catalog in the `reviewed by` line;
   (b) the pinned `-0910`. Recommend (a): it is the build the benchmark measured. Default: (a).
2. **Which tier.** Base (cheapest, stayed up) or Fast (about 10% faster output, stayed up); never Ultra.
   Default: Base for overflow builds, Fast for `adversarial-review` so a review is not the slowest lane.
3. **Claude builds go sealed at every pace.** The alternative is `agentic run build` exiting "pace under:
   use Agent(build)". Default: sealed at every pace, so the workflow does not flip with the quota.
4. **Retry budget.** Default: three attempts.

Risks to verify while building, each covered by `agentic run doctor`:

- The Claude flag combination (`--restricted`, sandboxed `--settings`, `--tools`, non-interactive
  permissions) runs sandboxed Bash without a prompt and refuses writes outside the tree.
- This machine's `pi` wrapper resets `PI_CODING_AGENT_DIR`; the launcher starts Pi's CLI directly, or the
  install contract changes the wrapper to keep a value already set. The wrapper is outside agent-kit.
- A parent session with the sandbox on would nest sandboxes; `failIfUnavailable` makes that a reported
  `sandbox-unavailable`, never an unsealed run.

## First implementation step

`agentic run doctor` with both adapters: launch each engine sealed against a scratch clone and prove the
invariant (tests pass inside; writes to the real checkout, `.git`, and `~/.ssh` fail; `git push` fails),
before any role is moved.
