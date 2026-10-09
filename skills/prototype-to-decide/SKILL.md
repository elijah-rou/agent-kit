---
name: prototype-to-decide
description: Settle a design fork that observation can decide (layout, interaction, density, behavior, timing, or approach) by building throwaway variants behind one switcher in a scratch directory, observing each on the matching surface, and recommending one. Use when choosing between alternatives that are cheap to build and observe, instead of asking the user to choose in the abstract. Not for production code, and not for one-way doors, which go to design-checkpoint.
---

# Prototype to decide

You own the decision, not the code. The prototype is a throwaway instrument: speed over polish, no tests, no abstractions. The rigor goes into picking the right option cheaply.

## 1. Scope the decision

Name the one decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork, which behavior, timing, or approach. No decision means no prototype: just build. A choice that fixes a public contract, persisted data, or a security boundary is a one-way door: use `design-checkpoint` instead.

Completion criterion: one sentence stating the decision and what observation will settle it.

## 2. Generate options

Include variants the user did not ask for when they could win; discard approaches freely. When the design space is wide open, gather prior art first with read-only research, and summarize the directions before building. Skip this when the direction is set.

## 3. Build throwaway variants behind one switcher

- Work in a scratch directory outside production source (a system temporary directory, or an ignored `scratch/` path). Never import prototype code into the product.
- Visual decisions: the lightest stack that renders the idea, such as plain HTML, CSS, and JavaScript with a hot-reloading server.
- Behavioral or timing decisions: the smallest script that exercises the question.
- Put every variant behind one switcher with visible labels: buttons or a key press for visual variants; one flag or environment variable for scripts. Comparing variants side by side through one entry point is the point.

## 4. Observe each variant

The observation is the test:

- **Visual:** drive each variant with a browser harness and capture a screenshot per variant, plus the interaction that matters.
- **Behavioral or timing:** log the timing, print the output, or watch the render, the same way for every variant. For a performance fork, run each variant several times and report the spread; time whole commands with the `verification` skill's command benchmark method.
- **Games:** record each variant with the same scripted input. Feel stays with the user: hand them the switcher to play.

Completion criterion: one piece of evidence per variant, captured the same way.

## 5. Decide or present

If the evidence settles a reversible choice, decide, record the decision with its evidence (in the decision log when the run has one), and carry on. When the choice is the user's to make (UX taste, game feel, data model), present the variants, the evidence, the tradeoffs, your recommendation with its reason, and the default you will take if they do not answer.

## Reply

The variants explored, the evidence for each, tradeoffs, the decision or recommendation, and the scratch path. Say plainly that the prototype is throwaway; the real build starts fresh from the chosen direction.
