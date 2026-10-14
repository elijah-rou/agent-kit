---
name: new-project
description: Sequence the start of a new project - the intent conversation, a README or tutorial first for code others will call, repo-baseline, design-checkpoint on the one-way doors, the first thin end-to-end slice, then create-verification - routing each step to the skill that owns it. Use when the user starts a new project, application, library, or service, or when a graduated spike becomes the real build, whether rebuilt from scratch or hardened in its spike repository. Not for other work in an existing repository; adopting one is repo-baseline alone.
---

# New project

A route through skills that already exist. Each step names the skill that owns it: follow that skill, not a summary of it. Take the steps in order, and skip one only for the reason the step itself gives.

## 1. Intent

Treat what the request states about the project (what it is for, who uses it, what its first version must do, which parts are shared code: a library, API, command-line interface, or file format that other code will call) as settled. Ask the user only the product or public-contract questions the request leaves open, each with concrete options, your recommendation and its reason, and the default you will take. Choose the first user journey yourself. If the stack is open and several are viable, choose it with `technology-selection`.

If the user is exploring and wants to co-design the system by building it, suggest `spike`; it stays the user's to invoke. A graduated spike enters this flow at step 2, from its `SPIKE.md` Handoff section.

Completion criterion: you can state the project's purpose, its first user journey, and its shared code in a few sentences, and each open product or public-contract question has the user's answer or your stated default.

## 2. README or tutorial first, for shared code

For each piece of shared code, write the document its caller would read before writing the code: how to install it, how to call it, and what comes back, in the caller's terms. It forces the caller's view, and it becomes the target the build is checked against. Use `technical-writing` when the document itself matters. Skip this step when nothing outside the project calls its code.

Completion criterion: the document exists in the project directory, or the project has no shared code and you said so.

## 3. Repository baseline

Run `repo-baseline` on the project directory, including on a graduated spike's repository when it is hardened in place. It covers the local git repository on `main` that the later steps commit to, and the rest of the project's baseline. When the directory sits inside another checkout, follow `repo-baseline`'s guard for that case in its audit step.

Completion criterion: `repo-baseline`'s own.

## 4. One-way doors

Take each one-way door the first version crosses, as `design-checkpoint` defines them in its first step, through `design-checkpoint`, using step 2's document as the caller's view of each contract. A data model is a door only when it is persisted, or when it is a core data structure in systems or games work. A graduated spike's one-way-door decisions are listed as unsettled in its Handoff section; take each through `design-checkpoint`, seeded with the spike's decision. Decide reversible forks yourself, or settle them with `prototype-to-decide` when observation can.

Completion criterion: every one-way door the first version crosses has a shape the user reviewed, or it crosses none and you said so.

## 5. First thin slice

Build step 1's first user journey as the first thin end-to-end slice, under the standing rule for thin slices, and use `feature-shaping` when the work after it spans several slices. Once the slice adds tests, `repo-baseline`'s Validate input covers what to rerun.

Completion criterion: the slice runs end to end and you have read its output.

## 6. Verification

Once the slice runs, the repository needs a verification skill so every later change is proved on the real surface. Outside a landing mode, offer `create-verification`; it runs when the user accepts. Inside a landing mode, `babysit-and-ship` makes it the queue's first unit. The flow ends at the offer, or when that skill is proved.
