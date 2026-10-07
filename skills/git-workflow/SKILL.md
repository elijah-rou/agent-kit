---
name: git-workflow
description: Git workspace and publication rules - choosing the current checkout or a worktree, keeping and removing worktrees, commit history, pushing, merging, pull requests, and replies to review comments. Use whenever a task creates a branch or worktree, commits, pushes, merges, opens or updates a pull request, or answers review threads.
---

# Git workflow

Repository conventions take precedence where they differ.

## Workspaces

- Default to the current checkout for bounded single-writer work. Inspect status first and preserve unrelated changes.
- Use an isolated worktree when asked, for concurrent writers, for broad, risky, or long-lived work, or when the checkout's state would conflict with the task. After creating a task worktree, keep the task's reads, edits, checks, and commits there.
- Keep one writer per checkout or worktree. Concurrent writers need separate worktrees and disjoint ownership.
- Keep a worktree until its commits reach the intended upstream branch or are otherwise confirmed reachable. Remove it only when clean and reachable, or after explicit abandonment; keep persistent streams unless asked.

## History

- Commit coherent changes locally, one concern per commit, with a short subject and a body that explains why. A pull request description is not stored in git or shown by `git blame`, so it never replaces the commit message.
- Prefer linear history; avoid merge commits unless requested or required.

## Publishing and merging

- Only the coordinating agent may push, merge (including local fast-forwards), deploy, or release. Subagents and external mutation-capable runners never do, and a different checkout, container, or backend does not widen that authority.
- Pushing and merging follow the repository's autonomy level: from A2, push `agent/<topic>` branches and open pull requests; at A4, land pull requests with a current independent verdict. Below that level, and at any level for the default branch, and for force-pushes or deletions of shared branches, they require explicit authorization naming the operation, repository, and scope.
- Name every branch you intend to push `agent/<topic>`.
- Before an authorized push or merge, recheck the exact revision and the full workspace against the final verification.
- Below the level that permits it, do not proactively offer to merge, publish, or open a pull request.
- Repositories the user owns on GitHub carry the `agentic-backstop` ruleset on the default branch. When creating or adopting one, apply it with `github-rulesets`.

## Pull requests and reviews

- A pull request has a short summary, the key decisions, and testing specific to the change.
- In public review replies, mention verification only when it is unusual, failed, materially relevant, or requested. Let reviewers resolve their own threads unless asked.
