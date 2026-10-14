# Working with agent-kit

How to prompt an agent that has agent-kit installed, for the five things you do most: start a project, maintain one, add a feature, prototype, and hand work off. It closes with where the agent stops for you. It covers Claude Code and Pi. The skills named here are in [`skills/`](../../skills/); their `SKILL.md` files are the source of truth.

There is no mode to switch on. The instructions are always loaded, so you state the outcome and what done means, and the agent decides everything reversible: it plans only when the risk calls for it, builds in thin verified slices, and in a repository you own pushes `agent/*` branches and opens pull requests ready for review. It does not merge until your words start a landing mode (see [Hand work off](#hand-work-off)). Run a skill marked manual by its name (`/<skill>` in Claude Code, `/skill:<skill>` in Pi); the agent picks the others up from what you ask.

## Start a new project

Ask for a new project with what it is for and what done means. The `new-project` skill takes it in order: it asks only the product and contract questions your request leaves open, writes the README or tutorial first for code others will call, sets up the repository (`repo-baseline`), takes each one-way door through `design-checkpoint`, builds the first thin slice, and then offers `create-verification`. You can also ask for any skill it names on its own. To design the system with the agent by building throwaway pieces first, run `spike` instead (see [Prototype](#prototype)).

> Start a new project: a CLI that mirrors one iCloud album to a folder. Done when `icp sync <album>` copies new photos and skips ones already there. Rust is fine.

## Maintain a project

| You want | Say, for example | What runs |
| --- | --- | --- |
| A bug fixed | "Imports fail on files with a byte-order mark. Fix it." | The agent reproduces it, fixes the cause, and adds one regression case. Hard or intermittent bugs go through `diagnosing-bugs`. |
| A pull request green | "Get #12 green." / "Is #12 green?" | `babysit-and-ship` in drive or check mode. Babysitting never merges. |
| To understand code | "How does the sync loop work?" / "Why do we retry three times?" / "Teach me the verdict ledger." | `how`, `why`, `teach` |
| To know where things are | "Catch me up." / "What's waiting on me?" | `catch-up`: what changed, what is running, and what waits on you, across your own threads where the thread tools exist |
| The verify skill audited | `/maintain-verification` | `maintain-verification` (manual). In T3, in a repository you own, a run you start after the verify skill is on trunk also schedules it weekly in a fresh thread, when no such schedule exists and your thread runs in full access, so the weekly runs never wait on a permission prompt. |
| A T3 Code automation added, listed, stopped, or removed | "List my T3 schedules." / "Disable the weekly upkeep schedule." | `t3-automation`: exact titles, prompts that fail safe once their instructions change, and schedules created only from a `full-access` thread. Disabling a schedule stops it for good; deleting it lets a later run recreate it. |
| A repeated mistake stopped | Correct it as it happens. | The agent records each correction; when you correct the same mistake twice it offers `correct` (manual), which makes the mistake impossible at the strongest level that works, such as a type, a check, or a test. |
| Lessons kept after a long session | `/reflect` | `reflect` (manual) writes only what you approve. |

## Add a feature

State the feature and its done check. How much process it gets depends on risk, not size:

- **Reversible:** the agent builds it, verifies it, and opens a pull request, with no plan and no question.
- **A fork an experiment can settle:** it builds the variants with `prototype-to-decide` and decides, instead of asking you which.
- **A one-way door:** `design-checkpoint` compares at least two shapes and stops for your review. Reversible work that does not depend on the shape continues meanwhile.
- **Several slices:** `feature-shaping` keeps a plan in the repository's own planning convention, or in `plans/<feature-slug>.md` where it has none, and builds slice by slice without asking for approval.

> Add CSV export to the report page. Done when the exported file opens in Numbers with the same rows as the table.

## Prototype

- **To choose between options,** ask for the comparison, or let the agent do it: "Prototype the two sidebar layouts and recommend one." `prototype-to-decide` builds throwaway variants in a scratch directory and decides a reversible choice itself. A choice that is yours (UX taste, game feel, the data model) comes to you with the variants, the evidence, and a recommendation.
- **To design a new system with the agent,** run `spike` (manual) in a new, empty directory outside any repository. It relaxes the production rules (no pull requests, reviews, or plans; shortcuts are marked `SPIKE:`), brings every real design fork to you, and records what you agree in `SPIKE.md`. Say "graduate" when the design settles. One-way-door decisions made in a spike are not settled: the real build takes each through `design-checkpoint`.

## Hand work off

Your own words start a landing mode, and it lasts only the run you started it in. The modes work only in a repository you own.

| You say | Mode | Who merges |
| --- | --- | --- |
| "autopilot", "full autopilot", "land these", "ship it", "merge these when they're verified", for independent changes | `autopilot-full` | Each pull request's own agent, after a fresh verifier's clean verdict; the agents run in parallel where their changes do not overlap |
| the same words for changes that depend on each other, or "land the stack", "going to bed, land it" | `ship` | The agent, for the contiguous verified run from the bottom of the stack |
| "stack them, I'll land", "build the stack, don't merge" | `autopilot-stack` | You |

- Every merge waits for `agentic verify status` to pass on the exact head being merged.
- A repository with no verification skill gets one first: `create-verification` opens it as the run's first pull request. It lands only by your countersign (below), and the rest of the queue does not wait for it.
- Name a pull request as yours ("land these, but #12 is mine") and it stops at merge-ready for you to review and merge.
- **Countersign.** A pull request that changes verification policy (a verification skill's verdict rules, the landing gate, or an expectation the verification skill checks) can never pass its own verification. The agent lists it under "Needs you" with its head SHA and patch ID, and it lands only when you approve it in your own words in the thread running the landing mode, for example "Countersign #44, patch 3f9c…". A changed patch needs new words.
- **Going to bed.** Say so ("going to bed, keep going on the migration"), and the agent suggests `/background-run`, which you start yourself. It checks four trust conditions, sets a done check that can pass or fail, and runs supervised if any condition fails. Add landing words to let it merge ("going to bed, land the stack"). Say "pause" or ask it to pick up the run later.

## Where the agent stops for you

At the end of substantial work, the agent's report opens with "Needs you": the decisions, risks, and claims worth checking, or "Needs you: nothing". These come to you:

- **One-way doors:** public contracts, persisted data, security boundaries, hard-to-reverse architecture, and in systems or games work also core data structures and the ownership and concurrency model. You review the shape before anything that depends on it is built.
- **Your hard parts:** data model, core data structures, concurrency, memory ownership, UX taste, and game feel. The agent says when a task touches one instead of handing you a fix to accept unread.
- **Countersigns** on verification-policy pull requests.
- **The always-pause list,** in every mode: deleting what it did not create, force-pushing shared history, deploys and releases, messages to people (it drafts them for you), credential or permission changes, and anything outside the authorized scope. A permission prompt, guard, or forge rule that blocks an action is final: the agent drafts the command for you.
- **Product decisions,** blockers, and checkpoints you asked for.
