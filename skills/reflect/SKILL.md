---
name: reflect
description: After a substantial session, review its transcript through three lenses (judgment, tooling, divergent), synthesize findings into Accepted, Rejected, and Backlog, route anything enforceable to the correct backlog, and, only after the user approves, apply skill edits and write the session's learning file `.agents/learning/sessions/<session-id>.json`. Use when the user invokes reflect. Not for trivial or off-topic sessions.
disable-model-invocation: true
---

# Reflect

Turn one session into durable learnings with evidence, and route each to its strongest home. One-offs are not learnings. Skip the run when the session was trivial or followed an existing skill without friction, and say so.

## 1. Locate this session's transcript

Use only the active workspace's transcript for this session: this session's transcript file under the current project's session directory. Never glob or read other projects' transcripts. Confirm the file is this session by matching its first user message. If no file resolves, write a tight digest of the session and use that instead.

Record the session ID and today's date; every learning carries them.

## 2. Review through three lenses, in parallel

Spawn three read-only reviewer subagents at once, each with its prompt from `references/` filled in with the transcript path or digest:

| Lens | Prompt | Model |
|---|---|---|
| Judgment | `references/judgment-reviewer.md` | the strongest available |
| Tooling | `references/tooling-reviewer.md` | a different family from the parent where available |
| Divergent | `references/divergent-reviewer.md` | the strongest available |

Use a subagent role or type limited to read-only tools. Reviewers never edit files, post, or commit. If subagents are unavailable, apply the three lenses yourself in sequence and say so.

Completion criterion: three numbered finding lists, or a recorded reason a lens returned nothing.

## 3. Synthesize

Spawn one synthesizer subagent with `references/synthesizer.md` and the three outputs inlined. It returns Accepted, Rejected, and Backlog, with a scope (`repo` or `global`) on every Accepted and Backlog item.

## 4. Route enforceable items to Backlog

Check every Accepted row yourself. Anything a lint, type, test, script, hook, or Cedar policy could enforce moves to Backlog, marked enforceable. Those items feed `correct`; skill prose is only for what no mechanism can enforce.

## 5. Get approval before any edit

Present the synthesizer's full output to the user. The user picks which rows to apply and may change their routing. Write nothing, not even the learning file, until the user answers. If the user is away, stop here and leave the output in the report's "needs you" part.

## 6. Apply approved rows

- A small edit to an existing skill: make it directly.
- A substantive edit, a description change, or a new skill: draft it as a reviewed change and run the skill validator on every touched skill.
- Never edit a pinned or installed skill checkout. Global skill changes are a proposed change on a branch of the skill library's repository; repository skills live under `.agents/skills/`.

## 7. Write the session learning file

Write the approved Accepted and Backlog items, and nothing rejected, to `.agents/learning/sessions/<session-id>.json` as a JSON array:

```json
[
  {
    "kind": "repo",
    "text": "One sentence stating the learning as a rule.",
    "evidence": { "session": "<session-id>", "date": "YYYY-MM-DD" },
    "enforceable": false
  }
]
```

- `kind`: `repo` for this repository, `global` for every repository.
- `enforceable`: `true` for Backlog items routed to `correct`.
- This session writes only its own file. Never edit another session's file or merge files; merging session files into repository learnings is a separate step the user reviews of combined results.

Parse the file back after writing it.

## Reply

Short list, no preamble: edits applied (path and one line each), proposed global changes (branch), the learning file path and entry counts by `kind` and `enforceable`, and dropped findings with the synthesizer's reason.
