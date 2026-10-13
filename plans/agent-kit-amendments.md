# Agent-kit amendments

## Status

- Track: interview
- Intended outcome: approved (decisions D1 to D7, 2026-10-14)
- Slice plan: draft
- Current slice: not started
- User checkpoints: none beyond landing each slice's PRs

## Authority

- User request (2026-10-14): turn the thread analysis, the pstack comparison, and the gaps found in both into one plan to amend agent-kit, in five groups: our own changes, changes pstack suggests, removals, replacements with a pstack concept, and additions from pstack.
- Existing artifacts: `docs/analysis/2026-10-13-pstack-interaction-flows.md` (PR #34), `skills/spike` (PR #35).
- Sources:
  - T3 threads for agent-kit, webshite, interview-tutor, icloud-photos-cli, pi-t3-runtime (2026-10-07 to 10-13), chiefly "Agent-Kit Behavior Alignment Audit" (`f98107a2`);
  - pstack at cursor/plugins `c86f349`;
  - agent-kit `main` at `23142b7`.

## Problem

Across the five projects, three complaints hold up in the transcripts:

- **Slow.** Most elapsed time was agents parked on a question (PTY thread: 28.5 h elapsed, about 4 h active), unbounded review rounds (#28: 13, #25: 10, #23: 5), and stalls nobody noticed (OAuth expiry: 6 h).
- **Ambiguous control.** The user's words ("autopilot merge these", "merge the pr") do not map to the modes, and "autopilot this" maps to a mode that never merges. Each agent improvised differently.
- **Needless asks.** About a third of asks were rubber-stamped ("take your 2 recommendations", "I agree with everything else").

The audit thread needed nine user interventions and ended with six of its eleven PRs merged by hand, four of them verified PRs held by Jev's 0.3 threshold.

## Acceptance evidence

- A rerun of the audit thread's opening request ("make all these changes in agent-kit in autopilot") on a repo with no verify skill reaches merged PRs with the user typing nothing but the request. Exceptions: the always-pause list and decisions only the user can make.
- No PR in an autopilot run takes more than two review rounds without either landing with listed notes or splitting into a follow-up.
- Every merged agent-kit change is live in the next session on the user's machine.

## Before anything: the installed kit lags `main`

`~/.claude/CLAUDE.md` links to bootstrap's pinned copy at `~/.local/share/bootstrap/tools/agent-kit`, at `543b756`, 32 commits behind `main`. Everything merged since 2026-10-12 (#25 to #33) is not live. That includes the rule about stalled children (`claude/CLAUDE.md:35`) and the fixed `agentic rulesets plan`. Slice 0 fixes this first; otherwise nothing below takes effect.

## 1. Our own changes (from thread evidence)

| ID | Change | Evidence |
|---|---|---|
| O1 | The installed kit follows agent-kit `main` without giving up commit pins: bootstrap keeps pinning by commit in `catalog.tsv`, and every agent-kit merge is followed by a bootstrap PR from `scripts/pin agent-kit <sha>`, landed under the same mode. A session-start check warns when the installed kit is behind `origin/main`. | 32-commit lag; stale `agentic` broke precondition 3 in three threads |
| O2 | Verification bootstrap: when the user asks for autopilot, a loop, a goal, or a background run, and the repo has no `verify-*` skill, the run's first unit is `create-verification`, landed as the first PR. No separate invocation. | Audit thread steps 1 and 2; Hyperfine `ship` refused; webshite and pi-t3-runtime have none |
| O3 | A local CI gate (see G3). | interview-tutor `main` red 5 of 6 runs; CI queues of 9 to 11 min; icloud-photos-cli and pi-t3-runtime have no CI |
| O4 | Cross-thread ownership through T3: an agent links every PR it works on, and before acting on a PR it checks whether another thread has it linked. One owner per PR, enforced by the link, not by prose in the PR body. | #13 claimed by two threads; a ruleset change in one thread that another didn't see; two writers in one webshite checkout |
| O5 | Machine resource check before fan-out: free disk for container verifiers, and a cap on parallel strong-model threads. | Docker disk at 0 bytes blocked two verifiers; five parallel Opus threads hit the session limit together |
| O6 | Scheduled ticks never repeat an unchanged ask. After three ticks with no change, the tick stops and sends one notification. | 12 identical hourly asks in the PTY thread |
| O7 | Evidence hygiene: verification evidence, logs, and commit metadata never hold account identifiers or secrets. Evidence is scanned before it is committed. | Apple ID in 10 evidence files; a TypeSafe key and an Instagram token pasted into chats |
| O8 | Out-of-scope review findings become follow-up issues, not fix passes on the PR. | #25 grew from a policy line into hardening a YAML parser |

## 2. Changes pstack's guidance suggests

| ID | Change | pstack source |
|---|---|---|
| P1 | Trigger words: "autopilot", "full autopilot", "merge when verified", and "land these" mean the merging mode. Only explicit words ("stack them, I'll land") mean the non-merging stack. The user's words are the invocation; the mode logs them as evidence. | `poteto-mode/SKILL.md` playbook table |
| P2 | Under a granted mode or a standing default: decide, act, report. For a call only the user can make, apply a default and report it, saying what they could tell you to do instead. No reply words, no offers, never a check or command the agent could run itself. | `poteto-mode` triggers; "Writing the reply"; `principle-never-block-on-the-human` |
| P3 | Session overrides: "going to bed", "run until done", "don't stop" mean keep going; "keep going" never triggers a pause. | `poteto-mode` Autonomy; `pause-safely.md` |
| P4 | Fresh subagents by default for every fix round and retry, with consolidated scope. Never resume-chain. | `poteto-mode` Subagents |
| P5 | Each tick re-reads its playbook from trunk (`git show origin/main:...`) and audits the run against it. | `autopilot-full.md` step 6 |
| P6 | Plan through code: for shared code, write the README or tutorial first; review a diff, never an abstract plan. | guide `04-design.md` |

## 3. Remove outright

| ID | What goes | Why |
|---|---|---|
| R3 | Codex support: `codex/` exports, the Codex prompt hook, Codex adapters, and Codex as a delegation target | User loses the subscription; export already frozen (D4: remove now) |

## 4. Replace with a pstack concept

| ID | Today | Replacement | pstack source |
|---|---|---|---|
| X1 | Forge `merge-gate` tier, `agentic verify publish`, required `agentic/verdict` check | Keep the `baseline` tier. Agents check the ledger before each merge (`agentic verify status <pr>` exits 0), as private repos already do. | `autopilot-full.md` step 5: the grant plus the root's clean verdict authorizes the merge |
| X2 | Policy PRs are `verifier-blocked` by definition, and the user hand-posts a status | Countersign: a gate or policy change needs verifier proof plus the user's approval in words, recorded by the agent | `autopilot-full.md` step 6 |
| X3 | Jev's PR-risk hold | Items the user names stop at merge-ready. Jev's PR-risk score stays, as an advisory line in the report and a trigger for a second audit lane (J1). | `autopilot-full.md` steps 1 and 5 |
| X4 | Verify skill required before any landing mode | A live lane through the verify skill, or a named driver where none exists; O2 builds the skill early | `autopilot-full.md` step 4 |
| X5 | "Every question gives options, a recommendation, and the default" (`claude/CLAUDE.md:56`) | P2 | `poteto-mode` triggers |
| X6 | An adversarial review before every PR opens, a re-review after each behavior push, and "never stop with a known blocking finding" | Verdicts `PASS` / `PASS+NOTES` / `FAIL`, filtered by lead judgment (nitpick gravity, hypothetical vs. actual, preference). Review runs once, inside the verification round. Two focused re-reviews at most, then land with notes or split. After two failed fixes on one premise, attack the premise. | `shipping.md` step 1; `interrogate/references/lead-judgment.md`; `principle-attack-the-premise`; `orchestrate.md` retry caps |
| X7 | git guard's shell parser (`agentic/tools/git-guard/shell.ts`, 1,002 lines) | The regex classifier plus the `baseline` ruleset and the always-pause list | pstack has no guard; its safety is the always-pause list plus the forge |

## Jev, enabled and measured (D2)

| ID | Change | Why |
|---|---|---|
| J1 | Take Jev's task-routing notes out of shadow and deliver them as advice; keep PR-risk as an advisory score. | D2: run Jev for real and judge it on evidence, instead of parking or tuning it blind |
| J2 | Build the measurement the routing design deferred: a route report over the recorded routes that shows, per note, how often it fired, whether the agent followed it, and whether the user corrected the result. Review it after one week of use. | The `route-report` and `route-eval` tools are designed but not built; without them "see how it performs" has no data |

## 5. Add what pstack has and agent-kit needs

| ID | Addition | pstack source | Note |
|---|---|---|---|
| A1 | Liveness: `children.tsv` with expected runtimes; a lane past its runtime with no side effect is stuck and replaced at once | `autopilot-full.md` step 6 | Would have caught the Codex child stuck on approval |
| A2 | Out-of-session watchdog through T3 `schedule_task`: it checks the program's threads and notifies the user when the root has failed (auth, session limit) | none (pstack runs owners in the cloud) | Gap in both; the in-session tick died with the session |
| A3 | `maintain-verification` on a T3 schedule per repo (weekly, plus after merges that touch mapped paths), opt-in when the verify skill lands | `maintain-verification-skill` daily automation | User's example |
| A4 | Catch-up: `ketchup`, extended across threads with T3 thread and PR state | `ketchup/SKILL.md` | "is anything running?", "what pr is waiting", "is anything not done?" |
| A5 | A user guide and a help entry ("which skill fits") | `docs/guide/`, `poteto-help` | Builds on PR #34 |
| A6 | An independent comment pass | `no-comments` | Gap 5 of the PR #34 analysis |
| A7 | Program budget: stop spawning at about 70% of the budget and land what is verified; two retries, then replan | `orchestrate.md` | |
| A8 | Outer loop: triage, reproduce, fix, verify, fed by a T3 webhook schedule | `automations/benny` | Supersedes the deferred Hermes design; last, only after A1 to A3 run cleanly |

## 6. Gaps in both systems

| ID | Gap | Proposal |
|---|---|---|
| G1 | No path from "autopilot" in a repo without verification | O2 |
| G2a | Greenfield design: neither kit sequences the start of a project | A `new-project` flow: an intent conversation (`spike` when exploratory), then the README or tutorial first (P6), then `design-checkpoint` on the data model and contracts, then the repo baseline (G2b), then the first thin slice, then O2 once something runs |
| G2b | No repo baseline. pi-t3-runtime had no git repo ("for the love of god init a git repo"). icloud-photos-cli and pi-t3-runtime have no remote or CI. No repo has an `AGENTS.md`. The license was asked late. | A `repo-baseline` skill backed by an idempotent script that audits and creates: git with `.gitignore`, license, README, `AGENTS.md` (conventions and the validate command), one `validate` entry point, CI that calls it, the GitHub repo plus `baseline` ruleset (with authorization), a secret-scan pre-commit hook, and the Jev opt-out decision. A local git repository is mandatory (D5); a remote, CI, and rulesets are set up case by case, never by default. Works for adopting existing repos too. |
| G3 | CI is remote only | One local `validate` entry point per repo that CI also runs. Agents run it on the committed head before every push (pstack: "a hook pass is not proof"), and the verdict records it bound to the SHA. CI then confirms. A CI failure on a SHA that passed locally is classified as environment or flake before code changes. A container mode covers other platforms. Pi's `project-validate` extension is the starting point. Agent-run only; no `pre-push` hook for now (D6). |
| G4 | Installed kit drift | O1 |
| G5 | No cross-thread ownership or resource view | O4, O5 |
| G6 | Root-session death goes unnoticed | A2 |

## Decisions (approved 2026-10-14)

- **D1. Merge authority:** drop the forge `merge-gate`; agents check the ledger before each merge, and the user's words start the merging mode (X1, P1).
- **D2. Jev:** keep it and enable it, then judge it on measured performance (J1, J2). Reading taken: routing leaves shadow; PR-risk stays but only advises.
- **D3. git guard parser:** drop `shell.ts`, keep the regexes (X7).
- **D4. Codex:** remove now (R3).
- **D5. Repo baseline:** a local git repository is mandatory; a remote and everything that needs one is case by case.
- **D6. Local gate:** an agent-run step; no `pre-push` hook for now.
- **D7. T3:** build on T3 tools, with a fallback that reports the feature as unavailable outside T3.

## Slices

Each slice is one PR or a short stack. It is verified with `verify-agent-kit`, and agent-kit's own changes land through the rules the previous slice set.

0. **Make `main` live (O1).**
   - 0a: bump bootstrap's pin to `14659cb`, the last commit before #28. At `23142b7`, Pi's `git-interceptor.ts` loads #28's shell parser on install and refuses commands Pi runs today (`curl … | sh`, `bash -l`, `git commit -n`). D3 drops that parser.
   - 0c: X7 in agent-kit (drop `shell.ts`, keep the regex classifier), then pin past it. 0b must not ship before 0c, or the automatic bump would switch the parser on in Pi.
   - 0b: the post-merge bump and the lag warning.
1. **Control:** P1, P2, P3, X5, O2, X4, X1, X2, X3.
2. **Review economy:** X6, O8, P4.
3. **Liveness and coordination:** A1, A2, O4, O5, O6, P5, A7.
4. **Repo baseline and local gate:** G2b, G3, O7.
5. **Greenfield flow:** G2a, P6, landing PR #35 (`spike`).
6. **Catch-up and guide:** A4, A5, PR #34 reworked into the guide.
7. **Scheduled upkeep:** A3, A6.
8. **Removals and Jev:** R3, J1, J2.
9. **Outer loop:** A8, only after slices 3 and 7 have run cleanly for a week.

## Notes from slice 0a review

- Correction records (#32) live under `$(git rev-parse --git-common-dir)/agentic/corrections/`. In a linked worktree that path is outside the working directory, so Claude Code may prompt on each write. Check this in slice 1, and move the path or allow it.

## Not doing

- Tuning Jev's thresholds before J2 has a week of data.
- Per-role model routing in the style of `setup-pstack`. Roles keep fixing their own models. Revisit if the `quick` and `Explore` roles stay unused after #33 goes live.
- `design-control-loop` changes. Decide after R3.
