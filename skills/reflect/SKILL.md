---
name: reflect
description: After a substantial session, review its transcript through three lenses (judgment, tooling, divergent), synthesize findings into Accepted, Rejected, and Backlog, route anything enforceable to the correct backlog, and, only after the user approves, apply skill edits and write the session's learning files `.agents/learning/sessions/<session-id>.json` (this repository's, and agent-kit's for kit-wide learnings). Use when the user invokes reflect. Not for trivial or off-topic sessions.
disable-model-invocation: true
---

# Reflect

Turn one session into durable learnings with evidence, and route each to its strongest home. One-offs are not learnings. Skip the run when the session was trivial or followed an existing skill without friction, and say so.

## 1. Locate this session's transcript

Use only the active workspace's transcript for this session: this session's transcript file under the current project's session directory. Never glob or read other projects' transcripts. Confirm the file is this session by matching its first user message. If no file resolves, write a tight digest of the session and use that instead.

Record the session ID and today's date; every learning carries them.

Collect this session's correction records. The instructions have the agent append one each time the user corrects it, to `<common>/agentic/corrections/<session-id>.json`, where `<common>` is the output of `git rev-parse --path-format=absolute --git-common-dir`, or list a `global` one in its report instead when this repository is not agent-kit. They are mistakes the user named directly; give them to every reviewer in section 2 with the transcript.

## 2. Review through three lenses, in parallel

Spawn three read-only reviewer subagents at once, each with its prompt from `references/` filled in with the transcript path or digest:

| Lens | Prompt |
|---|---|
| Judgment | `references/judgment-reviewer.md` |
| Tooling | `references/tooling-reviewer.md` |
| Divergent | `references/divergent-reviewer.md` |

Use a subagent role or type limited to read-only tools, such as the `review` role where the harness defines one. Reviewers never edit files, post, or commit. If subagents are unavailable, apply the three lenses yourself in sequence and say so.

Completion criterion: three numbered finding lists, or a recorded reason a lens returned nothing.

## 3. Synthesize

Spawn one synthesizer subagent with `references/synthesizer.md` and the three outputs inlined; if subagents are unavailable, follow that reference yourself and say so. It returns Accepted, Rejected, and Backlog, with a scope (`repo` or `global`) on every Accepted and Backlog item.

## 4. Route enforceable items to Backlog

Check every Accepted row yourself. Anything a lint, type, test, script, hook, or (where the repository evaluates one) Cedar policy could enforce moves to Backlog, marked enforceable. So does a judgment lesson no lint can check but a pull-request reviewer can, by pointing at the violating line: it is enforceable as a review rule (a `rules.toml` row at level `review`, applied by `pr-review`). Those items feed `correct`; skill prose is only for what neither a mechanism nor a reviewer can enforce.

## 5. Get approval before any edit

Present the synthesizer's full output to the user. The user picks which rows to apply and may change their routing. Write nothing, not even a learning file, until the user answers. If the user is away, stop here and leave the output in the report's "needs you" part.

## 6. Apply approved rows

- A small edit to an existing skill: make it directly.
- A substantive edit, a description change, or a new skill: draft it as a reviewed change and run the skill validator on every touched skill.
- Never edit a pinned or installed skill checkout. Global skill changes are a proposed change on a branch of the skill library's repository; repository skills live under `.agents/skills/`.
- A `global` learning is about the kit, not this repository. Propose it on a branch of the skill library's repository (agent-kit): any approved skill edit, plus an entry in agent-kit's own `.agents/learning/sessions/<session-id>.json` in section 7's format, with its `enforceable` flag, so a `correct` run in agent-kit picks up the enforceable ones. Never write it into this repository's learning file, unless this repository is agent-kit.

## 7. Write the session learning files

Write the approved `repo` items from Accepted and Backlog, and nothing rejected, to this repository's `.agents/learning/sessions/<session-id>.json` as a JSON array; `global` items go to agent-kit's file of the same name (section 6):

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

- `kind`: `repo` for this repository, `global` for the kit. A repository's file holds only its own items, so `global` entries appear only in agent-kit's files; when this repository is agent-kit, one file holds both.
- `enforceable`: `true` for Backlog items routed to `correct`.
- This session writes only files named for its own session ID. Never edit another session's file or merge files; merging session files into repository learnings is a separate step, and the user reviews its combined results.
- Copy this session's correction records (section 1) unchanged into the same array: `repo` ones into this repository's file, `global` ones into agent-kit's file with the `global` items. A record keeps its own fields (`kind`, `class`, `correction`, `text`, and the same `evidence` shape, with no `enforceable`). It is evidence for `correct`, not a learning: never rewrite it, drop it, or count it as one. Never edit or delete the corrections file itself.

Parse each file back after writing it.

## Reply

Short list, no preamble: edits applied (path and one line each), proposed global changes (branch), each learning file's path with its learning counts by `kind` and `enforceable` and its correction record count, and dropped findings with the synthesizer's reason.
