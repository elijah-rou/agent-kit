---
name: github-rulesets
description: Put the server-side backstop on a GitHub repository, a ruleset on the default branch that blocks deletion and force-pushes and keeps history linear, plus required pull requests and CI checks once the repository lands through verified stacks. Use when creating or adopting a repository, when `agentic rulesets plan` reports changes, or when a repository moves to autonomy A3 or above. Not for repositories hosted elsewhere.
---

# GitHub rulesets

The local policy gate is the first line: fast feedback and clear reasons. The forge is the backstop: it holds even when the local gate is absent, broken, or routed around. Every repository the user owns carries the `agentic-backstop` ruleset.

Agents push with the user's token, so GitHub cannot tell the user from an agent. The ruleset therefore has no bypass actors, and it guarantees mechanical properties only. It cannot show that a human approved a change.

## 1. Plan

Run `agentic rulesets plan <owner/repo>`. It is read-only and reports the default branch, visibility, the existing ruleset, and what an apply would change.

- Exit status 3 means rulesets are unavailable: a private repository on a plan without them. Report it with the two ways out (a paid plan, or making the repository public) and leave the repository to the local gate. Do not change visibility or billing.
- A repository with no CI has nothing for the merge gate to require; say so instead of picking a weaker tier silently.

## 2. Choose the tier

| Tier | Rules | Use when |
|---|---|---|
| `baseline` | No deletion, no force-push, linear history on the default branch | Always. It adds no friction for direct pushes. |
| `merge-gate` | Baseline, plus a pull request, the `agentic/verdict` check that `agentic verify record` posts for a fresh verifier's verdict, and the CI checks that passed on the default branch head | The repository is at A3 or above (`agentic status`) and lands through pull requests. The user lands through pull requests too from then on. |

Checks that did not pass on the head are listed and left out; a failing check would block every merge. Fix CI first if the user wants it required.

## 3. Apply with authorization

Applying changes remote settings, so it needs the user's authorization naming the repository and the tier. Ask once for a batch of repositories, with the plan output, a recommendation, and the default (`baseline` everywhere it is available).

Then run `agentic rulesets apply <owner/repo> --tier <tier>`. It creates or updates the ruleset by name, so rerunning is safe, and it reads back the branch's active rules to verify. Report the verified rules per repository, and any repository left unprotected with the reason.

## 4. New repositories

When creating a repository, apply `baseline` right after the first push of the default branch, in the same authorization as creating the repository. Record the tier in the report so the user knows the backstop is in place.
