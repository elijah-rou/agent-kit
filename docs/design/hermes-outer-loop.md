# Hermes as the outer loop

- **Status:** proposed 2026-10-12, deferred. Nothing here is built or scheduled.
- **Reader:** whoever designs the outer loop: the user, or an agent briefed to build it.

## What the outer loop is for

In Lauren Tan's talk on agent trust ([video](https://x.com/poteto/status/2102050467505430555)), Grok Bot is the outer loop. It is connected to Slack, Sentry, and other services, reacts to their events through routines, and starts cloud agents that reproduce bugs and open pull requests. The coding agents are the inner loop.

Here the same split has three parts:

| Part | Role | Owns |
| --- | --- | --- |
| Hermes agents ([Hermes Agent](https://hermes-agent.nousresearch.com/)) | The managerial team | Talking with the user (calls, Signal, other messaging), generic tasks for each agent's specialty, intake of events, and deciding when coding work is needed |
| T3 Code, with Orchestrator V2 | The coding org | Threads, worktrees, delegated tasks on Pi, Codex, and Claude, and pull requests |
| agent-kit | The method | Instructions and skills that every coding agent in T3 runs on |

`pi-t3-runtime` (`~/Projects/pi-t3-runtime`) is T3's Pi runtime and sits inside the coding org.

## One interface: a signed job into T3

Hermes starts coding work only by posting a job to a T3 webhook task: `schedule_task` with `{"type":"webhook"}` and a `signature.secretRef`. The job carries named fields (repository, issue or pull request, requested work class, requester). The T3 task's prompt reads them only through `{{body.path}}` placeholders, never as free text.

Hermes never drives coding agents itself. Its bundled `claude-code` and `codex` skills could, but that would create a second executor beside V2. `pi-t3-runtime`'s design gives V2 sole ownership of "delegated launches, task IDs, lifecycle, cancellation, results and app persistence", and replaces its Pi fork's own subprocess fleet in T3 mode. Results flow back the other way: the T3 thread finishes, and Hermes relays the outcome to the user.

Jev routing is built, with its notes in shadow (`jev-task-routing.md`). A job may later carry an explicit work class for it; until a job does, the T3 side classifies the job like any other task.

## The line for coding work

Coding jobs follow the stages pstack's issue-report automation uses (`pstack/automations/benny`):

1. **Triage:** expected behavior, duplicate, or real defect.
2. **Reproduce:** the exact symptom, twice, through the repository's verification skill and its feature map.
3. **Fix:** a pull request, opened ready for review, with before-and-after evidence.
4. **Review and verify:** the adversarial pull-request review (`skills/git-workflow/references/pr-review.md`, from PR #14) and a fresh verifier.
5. **Land:** only through a mode the user invokes (`babysit-and-ship`).

Every stage can stop the line, and each hands its evidence to the next. A repository without a verification skill fails closed at step 2.

## Trust boundary

Hermes is the internet-facing part, so it holds the fewest capabilities.

- **Content is untrusted even when the sender is authenticated.** Hermes's webhook docs say "HMAC validation authenticates the _sender_, not the _content_" and that "the trust boundary is the agent's capability surface". Routes that read outside content get no terminal or outbound tools.
- **Only trusted triggers start coding work:** events the user authors, such as a label the user applies, a message from the user, or a CI failure on the user's own branches. Text written by other people is data inside a job, never its instruction.
- **Unattended runs deny approvals.** Hermes denies commands that need approval in cron and webhook sessions by default ([security](https://hermes-agent.nousresearch.com/docs/user-guide/security)). Keep that default, keep sender allowlists on messaging, and run the gateway in Docker or on a separate machine.
- **Messages to people stay drafts** for the user, as the instructions require.
- **Identity is open.** Agents use the user's GitHub token. ADR 0001 says to revisit an agent identity when agents run unattended on repositories others depend on.

## Why it waits

T3 can already receive signed GitHub webhooks on its own. Hermes earns its place when at least one of these matters:

- intake that keeps running while the laptop running T3 is off;
- a phone or voice front door;
- event sources beyond GitHub;
- cheap triage before a coding run starts;
- generic, non-coding tasks.

## Before building

1. Choose the always-on host for Hermes.
2. Observe what a T3 webhook task does when the app is closed or offline (queues, drops, or errors), and whether it needs T3 Connect. This is not yet verified.
3. Calibrate Jev routing: `route-report`, labeling, and `route-eval`.
4. Decide the identity question.
5. Run `design-checkpoint` on the job contract between Hermes and T3. Other components will consume it, so it is a one-way door.
