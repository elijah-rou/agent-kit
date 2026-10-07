---
name: design-checkpoint
description: Before building across a one-way door (public contract, persisted data or format, security boundary, hard-to-reverse architecture, and for systems and games also core data structures or the ownership and concurrency model), sketch types, signatures, and module shape, compare at least two structurally distinct candidates, and present the chosen shape for the user's review before implementing it. Use when a task crosses such a door. Not for reversible work, which proceeds without a plan, or forks a prototype can settle.
---

# Design checkpoint

At a one-way door, the user reviews the design shape before anything that depends on it is built. This is the only pre-build checkpoint. Reversible work proceeds without a plan.

## 1. Confirm the door

The work is a one-way door when it fixes any of:

- a public contract: an API, CLI flags, a wire or file format others consume;
- persisted data: schemas, migrations, on-disk or saved-game formats;
- a security boundary: authentication, authorization, credentials, sandboxing, trust between components;
- hard-to-reverse architecture: process boundaries, ownership of shared state, a major dependency;
- for systems and games: core data structures, memory ownership, the concurrency or threading model, the simulation loop and its determinism.

If none applies, do not use this skill: build it (reversible), or use `prototype-to-decide` (a fork observation can settle). If you are unsure, treat it as a door.

Completion criterion: the door is named in one sentence, with the irreversible part separated from the reversible work around it.

## 2. Ground the problem

Trace every system the new shape touches, from entry points to effects, with source citations. When the design changes ownership or layering, find why the current shape exists, so that reason becomes a constraint rather than a guess. Skip only for true greenfield work with nothing to integrate.

## 3. Generate candidates

Require at least two structurally distinct candidates: different whole shapes, not variations inside one shape.

1. Write the rubric first: three to six gradeable criteria for this task. Candidates never see it.
2. Spawn one subagent per candidate, in parallel, each in its own scratch directory or worktree, each with the same prompt: `references/candidate-prompt.md`, the task, and the grounding. Prefer different model families across candidates, through role or agent profiles on different providers or models where available. Candidates do not know about each other.
3. If subagents are unavailable, write the candidates yourself in sequence, each before looking back at the last, and say so.

Each candidate returns a package shaped by `references/rationale-template.md`: caller usage first, then types and signatures with `not implemented` bodies, a module map, and a rationale. A candidate that fails to return is dropped and noted.

## 4. Choose a base and graft

1. Read every candidate end to end.
2. Screen each against `references/design-red-flags.md`.
3. Score each against the rubric, criterion by criterion. Optionally spawn one read-only judge on a different model family with the rubric and the candidates by label; disagreement with your scores means bias or an ambiguous rubric, so reread both before deciding.
4. Pick as base the candidate a future maintainer can extend without breaking its invariants. When two tie, prefer the smaller public surface that hides more.
5. Graft the one or two strongest ideas from each other candidate into the base by hand, keeping one coherent model. Record what came from where and what was rejected.

Convergent candidates are a strong signal: ship the consensus shape. Wildly divergent candidates mean the framing was underspecified: refine step 1 and rerun, rather than averaging.

## 5. Present the shape for review

Commit the synthesized sketch and rationale on the working branch, in the repository's design-docs location or next to the code it shapes. Then present to the user, "needs you" first:

- the door and why it is one;
- the usage sketch and the types and signatures;
- the synthesis decision, the tradeoffs accepted, and the alternatives rejected;
- each open question with concrete options, your recommendation and its reason, and the default you will take.

Wait for the user's review before building anything that depends on the shape. Meanwhile, continue reversible work that does not depend on it. Pushback on the shape is new grounding: return to step 2.

## 6. Build against the sketch

The sketch is the contract. Surface every deviation instead of absorbing it: either the sketch was wrong, a requirement was missed, or the implementation overreaches. Scrap the sketch and return to step 2 when friction forms a pattern: the same workaround in unrelated places, special cases piling up, type escape hatches, a lock the sketch said was unnecessary, or callers needing the abstraction's internal rules. A changed one-way-door shape goes back to the user.
