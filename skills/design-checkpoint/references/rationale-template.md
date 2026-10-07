# Rationale template

One page that ships with the type sketch. Sentence-case headings. Replace each note with content; drop nothing marked required.

## Problem

One paragraph: what we are doing, and what about the existing system makes the shape non-obvious. Name constraints from grounding: types to interoperate with, callers that must not break, invariants crossing the boundary.

## Usage (caller's view)

Required, written before the types. The quickstart a consumer reads, plus two or three realistic call sites: what they import, call, and get back. The type sketch derives from this; when they disagree, change the sketch.

## Shape

Data structures first, then how data flows through the signatures. Name the load-bearing decisions, the invariants encoded in types, where validation happens, and what the system deliberately does not do. State what complexity the public surface hides and why it is no larger than needed.

## Synthesis decision

Which candidate became the base and why, what was grafted from each other candidate, what was rejected and why, and any dropped candidates.

## Tradeoffs accepted

One bullet each, in the form "we accept X in exchange for Y". Include anything a reader might mistake for an oversight.

## Alternatives considered

Required. At least one concrete alternative shape, with one line on why it lost, judged on the complexity it exposes to callers versus what it hides. If constraints forced the answer, say "this was the only viable shape because...".

## Open questions and risks

Phrased as questions for the user, each with options, a recommendation, and the default the agent will take.

## First implementation step

One sentence: the first thing to build once the shape is approved.
