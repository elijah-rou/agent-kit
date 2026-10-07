# Pull request body

A briefing, not a lab notebook. A reviewer who has the diff should learn, in under a minute, why the change exists, what it leaves out, what it could break, how it was proved, and how to undo it. Short sentences, few identifiers. The squash commit body is the PR body, so keep it under about 40 lines.

Use these `##` sections, in order. Drop a section only when it has nothing to say; Scope, Verification, and Revert are always present.

- `## Why`: the problem and the approach, in one to three sentences.
- `## What changed`: one to three bullets. Name a symbol or path only when it carries the change. Name both sides of a rename.
- `## Scope`: what the PR covers and what it deliberately leaves out, such as a follow-up or a known gap. One to three items.
- `## Tradeoffs`: only rejected alternatives a reviewer would otherwise ask about.
- `## Blast Radius`: one or two sentences on who or what the change touches, and why that is safe or risky. If trunk is red, the cost of leaving it red.
- `## Verification`: one to three bullets, each a real command or journey and its observed outcome. For performance, one primary number with its unit, `before -> after`. Link longer evidence instead of pasting it.
- `## Revert`: how to undo it and what that costs: usually reverting the squash commit, plus any data, migration, or configuration step a plain revert would not undo.

Attach screenshots or video only when they prove a claim. Leave out full SHAs, file-by-file checklists, and agent narration.

## Titles, size, and stacks

- Follow the repository's title convention; otherwise a short imperative subject.
- Prefer several narrow PRs to one large one.
- A stack is a chain of base branches: the bottom PR targets trunk, and each child targets its parent's branch, rebased onto the parent's exact tip. Branch from trunk only for independent work.
- Where the standing default lets you open PRs, open them ready for review, not as drafts. Opening a PR does not start a babysit; finish the stack first.
