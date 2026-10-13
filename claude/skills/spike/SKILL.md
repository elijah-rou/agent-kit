---
name: spike
description: Run a greenfield throwaway prototype as a live design session with the user, thinking the system through together and building small pieces fast to test ideas, under lighter rules than production work. Ends with a graduate step that hands the settled design to the normal rules. Use only when the user invokes spike.
disable-model-invocation: true
---

# Spike

You and the user are designing a system together, and code is how you both think. The code is throwaway; what survives is the design you settle together, recorded in `SPIKE.md`. Optimize for the pace of the conversation, not the quality of the code.

## 1. Check the workspace

The relaxed rules apply only to a workspace that exists for the spike. Admit exactly two cases:

- **New spike:** a new or empty directory that is not inside another repository's checkout. Initialize git and create `SPIKE.md` with three headings: Decisions, Open questions, Handoff.
- **Resumed spike:** a git repository with `SPIKE.md` at its root, no remote, and no `Graduated` line in `SPIKE.md`. Read `SPIKE.md` and the git log, and continue from them.

Refuse anything else, including an existing project that was never pushed and a graduated spike, and propose a new directory instead.

Completion criterion: the workspace is one of the two cases, is a git repository, and has `SPIKE.md`.

## 2. Rules for this run

For this workspace and until the run ends, these replace the standing rules on the same topics:

- **No one-way doors yet.** Nothing is persisted, published, or depended on, so the data model, contracts, core structures, and concurrency model are reversible here. Do not run `design-checkpoint`; raise these choices in conversation (step 3).
- **No ceremony.** No pull requests, review children, plan files, `.audit/` decision logs, `show-me-your-work`, or `feature-shaping`.
- **Code design.** Do not apply `code-design` or the standing code-structure rules. Keep only failing loudly on programmer error, which makes debugging faster.
- **Debt is allowed and marked.** Take shortcuts, and mark each with a `SPIKE:` comment saying what is faked or skipped; it needs no tracking issue. No regression case per bug; fix it and move on.
- **Replies.** Short and conversational, no report headings.
- **The user is in the room.** Bring every design fork with real consequences to the user with your recommendation, instead of deciding it silently. Decide trivia yourself.
- **Writers.** Children may write in this checkout at the same time as you, on disjoint files (step 3), instead of in the separate worktrees `git-workflow` requires for concurrent writers.

Unchanged: authorization and security rules (no secrets in source; permission prompts and guards; destructive actions; creating a remote, pushing, or anything else outward-facing still needs authorization), and evidence rules (do not say a piece works until you have run it and read its output; confirm a bug's symptom before fixing it).

## 3. The loop

Repeat until the user graduates or drops the spike:

1. **Think with the user.** Engage with each idea: name its consequence, the strongest alternative, and the question that would decide between them. Push back on weak assumptions. When the shape is the question, sketch it inline as types, signatures, or data flow before writing code.
2. **Build to answer a question.** When running something can answer the open question, build the smallest piece that does (a script, a REPL session, a printed trace) and show the output. For a fork that observation can settle, build both variants behind one switch and show both.
3. **Delegate building, not thinking.** Once a piece's shape is agreed and it splits into independent parts, or is bulk work (scaffolding, fixtures, generated data, boilerplate), launch `quick` children in the background. Each brief names the files the child owns, the agreed shape, the check it runs, that it never runs git, and that shortcuts get a `SPIKE:` comment. Keep talking with the user while they work, and edit only files no running child owns. Make small edits yourself, since a brief costs more than a few lines. Run a child's result before presenting it.
4. **Record.** Add a decision to `SPIKE.md` only when the user made or agreed to it, one line with its reason. Keep open questions there too.
5. **Checkpoint.** Run no git command that writes while a child is running. Once none is, commit each working change with a message naming what it tried. To undo, reset to the earlier checkpoint once the working tree is clean; the abandoned commits stay reachable through the reflog.

Completion criterion for each turn: the user has the output, sketch, or question they need to take the next design step.

## 4. Graduate

When the user says to graduate, or agrees the design has settled:

1. Fill the Handoff section of `SPIKE.md`: settled decisions, open questions, every `SPIKE:` shortcut (grep for them), and what the code proved and did not prove.
2. In the Handoff section, list every decision the spike made that crosses a one-way door as `design-checkpoint` defines them in its first step. Mark each as settled under spike rules: the real build takes each through `design-checkpoint`, seeded with the spike's decision, instead of reusing it as settled.
3. Recommend rebuilding from scratch or hardening in place, with the reason. The user decides.
4. Add a first line `Graduated: <date>` to `SPIKE.md` and commit, so step 1 never admits this workspace again.

The run ends at graduation or when the user drops the spike, and the relaxed rules end with it. The real build follows the standing rules from its first step; once it runs, offer `create-verification`. A later session resumes the spike only when the user invokes spike again.
