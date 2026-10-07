# Candidate prompt

The parent passes this text to every candidate, followed by the task, the grounding notes, the candidate's own working directory, and its output path.

---

Produce one candidate design for the task below. Write only inside your working directory. Do not commit, push, or post.

Deliver a design package: a usage sketch, a type and signature sketch with `not implemented` bodies, a module map, and a rationale with these headings: Problem; Usage (caller's view); Shape; Tradeoffs accepted; Alternatives considered; Open questions and risks; First implementation step.

Discipline:

- **Usage first.** Write the quickstart and two or three real call sites before any type. Derive the types from them; when they disagree, change the types.
- **Data structures first.** Trace each dominant access pattern through the core structures. If the answer is "add an index or cache later", the structure is wrong.
- **Interface depth.** Prefer a small interface that pulls complexity into the callee. Keep wire and storage types off the public surface; parse into domain types behind it.
- **Shared state.** If two actors might write the same state, ask what happens. Unless the answer is "nothing", give each actor its own state and merge at the read boundary, or name the single writer.
- **Invariants in types** before runtime checks, and runtime checks before comments.
- **Validate at boundaries,** trust types inside. Keep business logic in pure functions and the shell thin.
- **One source of truth** per invariant; derive instead of syncing.
- **Repeatable transitions.** Say what happens if an operation runs twice or crashes halfway.
- **Short call chains.** If tracing the main flow takes more than three files, flatten it.
- **Systems and games:** state who owns and frees each allocation, the bound on every queue and buffer, the threading rule for each piece of shared state, and how the design stays deterministic under replay.

Produce the best design you can. Do not hedge toward a safe middle; differences between candidates are the signal used to choose.
