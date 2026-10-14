---
name: github-rulesets
description: Put the server-side backstop on a GitHub repository, a ruleset on the default branch that blocks deletion and force-pushes and keeps history linear. Use when creating or adopting a repository, or when `agentic rulesets plan` reports changes. Not for repositories hosted elsewhere, and not the merge gate, which is the local verdict ledger (`babysit-and-ship`).
---

# GitHub rulesets

Instructions and local guards are the first line. The forge is the backstop: it holds whatever an agent does locally. Every repository the user owns carries the `agentic-backstop` ruleset.

Agents push with the user's token, so GitHub cannot tell the user from an agent. The ruleset therefore has no bypass actors, and it guarantees mechanical properties only. It cannot show that a human approved a change.

The ruleset does not gate merges. Merging modes check the verdict ledger with `agentic verify status` right before each merge, in every repository, public or private (`babysit-and-ship`).

## 1. Plan

Run `agentic rulesets plan <owner/repo>`. It is read-only and reports the default branch, visibility, the existing ruleset, and what an apply would change: `+rule` to add, `-rule` to remove, and `~setting` for enforcement, bypass actors, or target branches that differ.

- Exit status 3 means rulesets are unavailable: a private repository on a plan without them. Report it with the two ways out (a paid plan, or making the repository public) and leave the repository to the instructions and the harness's permission prompts. Do not change visibility or billing.
- A repository that still carries the retired `merge-gate` rules plans `-pull_request -required_status_checks`. Applying removes them, so GitHub stops requiring the `agentic/verdict` status that nothing posts any more.

## 2. The ruleset

No deletion, no force-push, and linear history on the default branch, with no bypass actors. It adds no friction for direct pushes, so it goes on every repository where rulesets are available.

## 3. Apply with authorization

Applying changes remote settings, so it needs the user's authorization naming the repository. Ask once for a batch of repositories, with the plan output, a recommendation, and the default (apply everywhere it is available).

Then run `agentic rulesets apply <owner/repo>`. It creates or updates the ruleset by name, so rerunning is safe, and it reads back the branch's active rules to verify. Report the verified rules per repository, and any repository left unprotected with the reason.

## 4. New repositories

When creating a repository, apply the ruleset right after the first push of the default branch, in the same authorization as creating the repository. Say in the report that the backstop is in place.
