---
name: new-project
description: Sequence the start of a new project - the intent conversation, a README or tutorial first for code others will call, design-checkpoint on the one-way doors, repo-baseline, the first thin end-to-end slice, then create-verification - routing each step to the skill that owns it. Use when the user starts a new project, application, library, or service, or a graduated spike becomes the real build. Not for work in an existing repository; adopting one is repo-baseline alone.
---

# New project

A route through skills that already exist. Each step names the skill that owns it: follow that skill, not a summary of it. Take the steps in order, and skip one only for the reason the step itself gives.

## 1. Intent

Before writing any file, settle with the user what the project is for, who uses it, what its first version must do, and which parts are shared code: a library, API, command-line interface, or file format that other code will call. If the stack is open and several are viable, choose it with `technology-selection`.

If the user is exploring and wants to co-design the system by building it, suggest `spike`; it stays the user's to invoke. When a spike graduates, start this flow at step 2 from its `SPIKE.md` Handoff section: its settled decisions seed the build, and each one-way-door decision listed there goes through step 3.

Completion criterion: you can state the project's purpose, its first user journey, and its shared code in a few sentences the user agreed to.

## 2. README or tutorial first, for shared code

For each piece of shared code, write the document its caller would read before writing the code: how to install it, how to call it, and what comes back, in the caller's terms. It forces the caller's view, and it becomes the target the build is checked against. Use `technical-writing` when the document itself matters. Skip this step when nothing outside the project calls its code.

Completion criterion: the document exists in the project directory, or the project has no shared code and you said so.

## 3. One-way doors

Take the data model, public contracts, persisted formats, security boundaries, and hard-to-reverse architecture (and in systems or games work, core data structures and the ownership and concurrency model) through `design-checkpoint`, using step 2's document as the caller's view of each contract. Decide reversible forks yourself, or settle them with `prototype-to-decide` when observation can. Give the user a document, a sketch, or a prototype to review, never an abstract plan.

Completion criterion: every one-way door the first version crosses has a shape the user reviewed, or it crosses none and you said so.

## 4. Repository baseline

Run `repo-baseline` on the project directory. It always creates a local git repository and keeps a README step 2 wrote, since it never overwrites a file; a remote, CI, and a ruleset are each the user's call, case by case, as that skill describes.

Completion criterion: `repo-baseline`'s own.

## 5. First thin slice

Build the thinnest path through step 1's first user journey, end to end, and run it the way a user would before widening any layer. When the work after it spans several slices, plan them with `feature-shaping`. If step 4 left the validate command `manual` because the project had no commands yet, rerun `repo-baseline` once the slice adds tests.

Completion criterion: the slice runs end to end and you have read its output.

## 6. Verification

Once the slice runs, build the repository's verification skill with `create-verification`, so every later change is proved on the real surface. The flow ends when that skill is proved.
