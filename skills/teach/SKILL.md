---
name: teach
description: Explain a subsystem, change, or failure plainly so the user actually understands what it is, how it works, and why it is built that way, at the user's pace. Use when the user asks to be taught or to really understand something, and offer it before the next fix attempt when an agent has failed twice on the same area or a result surprised the user. Not for quick factual lookups or code changes.
---

# Teach

Explain one thing so the user understands it well enough to steer, judge, and debug it. Change nothing. The goal is understanding for development, not retention: no quizzes, no recall drills.

## When this triggers on a failure or surprise

When an agent has failed twice on the same area, or a result surprised the user, stop before the next fix attempt and offer this skill. Ask with options and a default:

- teach the area now (recommended: two failures mean someone's model of the system is wrong);
- try one more fix with a different premise;
- stop and report.

Default if the user is away: do not attempt another fix on the same premise. Write the explanation into the report's "needs you" part, flag the area as a hard part, and move to other work.

For a failure-triggered teach, center the explanation on the gap: what the failed attempts assumed, what the system actually does, and where the two diverge.

## Steps

1. **Choose what they should walk away with.** Two or three things, chosen from why they are asking (changing it, reviewing it, debugging it, new to it) and what the conversation shows they already know. Skip what they plainly know.
2. **Ground it in source and history.** Trace the real flow from entry point to effect in the code, and the history of the decisions that shaped it. Use the `how` and `why` skills where installed, in parallel for a subsystem, one of them for a small change. Keep the history search narrow unless the reasons are the point. Keep confidence language from the history ("likely", "no record found") intact; those hedges are findings.
3. **Start with a plain definition.** Name the thing and say what it is in general terms, with its common name if it has one. Then tie it to this codebase ("here, this is used to...") and build outward: how it works, then why, then edge cases. For each part, give the problem it solves and the mechanism. Listing functions is reference, not teaching.
4. **Give the smallest complete answer first,** a sentence or two, then stop and let them respond. Add layers when they ask. Running without a live user, deliver the whole explanation cleanly and put the offer to go deeper at the end.
5. **Show the system assembling.** Open the code or diff when that is fastest. For three or more moving parts, draw a short series of diagrams (Mermaid or plain text), each redrawing the last and adding one part. A single all-at-once diagram is reference, not teaching. A simple point needs no figure.

## Style

Plain spoken sentences, the way you would explain it to a colleague. State the concrete mechanism, not a metaphor or a preview. One name per concept, kept throughout. Prefer periods to commas; at most two commas per sentence. No framing labels ("the key insight", "TL;DR"), no pacing theater ("this is the tricky part"), no em dashes.

## Reply

The explanation itself, never a report about it: the main point first, then what it is, how it works, and why, then the threads worth pulling next.
