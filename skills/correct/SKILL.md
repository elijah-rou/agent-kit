---
name: correct
description: Find the mistake classes agents repeat in this repository and make each one impossible, fixing at the highest level that works (architecture, types, a lint or CI check whose error names the fix, a test, docs last), proving every new check fails on a real past mistake, and recording it in the rule-to-enforcer table `rules.toml`. Use when the user invokes correct, or asks to stop a recurring agent mistake for good. Not for fixing one bug.
disable-model-invocation: true
---

# Correct

Change the repository so the next agent cannot make the mistakes the user keeps correcting. Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. A change that looks right from one file must be right for the whole repository.

## 1. Find the mistake classes from history

Read evidence, not memory, and only from this repository and workspace:

- recent commits, reverts (`git log --grep=Revert`), and fix-up commits;
- review comments on recent pull requests, read-only;
- agent instruction files and the current `rules.toml`;
- code comments that justify a workaround;
- decision logs under `.audit/`, and entries with `"enforceable": true` in `.agents/learning/sessions/*.json` (the learning loop's backlog for this skill).

Group mistakes into classes. A class counts once it has happened twice. A correction for a rule already in `rules.toml` whose enforcer is only docs counts as a repeat: fix it at a higher level in the same change.

Completion criterion: a list of classes, each with two or more concrete evidence pointers (commit SHA, PR comment, `file:line`, session ID).

## 2. Fix each class at the highest level that works

1. **Architecture.** One owner per piece of state, one supported way per task, internals that fail to import from outside, one source of truth instead of hand-synced lists. Delete old ways and dead code an agent would copy.
2. **Types.** Make the bad state unrepresentable.
3. **Lint or CI check.** When bad code still compiles, add a check whose error message names the file, type, or function to use instead. When the action is an agent action rather than code (publishing, merging, posting, editing a protected path), the enforcer may be a Cedar `forbid` policy in the repository's `.agents/policy/*.cedar`, identified by its `@id("...")`. Repository policy files contain only `forbid` statements.
4. **Behavior test.** Fix or delete any test that would still pass if every function it calls returned nothing.
5. **Docs or agent rules, last,** and only for real judgment calls. Nothing fails when an agent skips them.

Ratchet common patterns: when a pattern already appears widely, fail only when a change adds more of it, against a committed baseline count. Never weaken an existing check to make a new one pass.

Completion criterion: each class has a chosen level and one sentence on why every higher level did not work.

## 3. Prove each check fails on a real past mistake

Fix the most frequent classes first, one commit per class.

1. Reproduce a real past mistake: check out its commit in a scratch worktree, or apply its diff there.
2. Run the exact command CI runs. Observe the failure and confirm the error names the fix.
3. Run the same command on the fixed tree and observe a pass.
4. Wire the same command into the repository's local check and CI, so both run it identically.

A check that has never failed on a real mistake is unproven; do not record it as an enforcer.

Completion criterion: for each new check, the failing and passing outputs were observed and their commands recorded.

## 4. Handle exceptions explicitly

An exception lives on the offending line, as the check's suppression syntax, with a reason, an expiry date, and the approving human. Never approve an exception yourself. Ask the user with concrete options, a recommendation, and the default you will take: by default, fix the code instead of suppressing.

## 5. Maintain `rules.toml`

`rules.toml` is the single rule-to-enforcer table. Instruction files may link to it; do not hand-copy it into them. Each `[[rule]]` row pairs a rule (`id`, `statement`) with its enforcer level, the enforcer itself (check command, test, or type), and its proof (the past mistake and the command that failed on it). After every edit, confirm that each row's enforcer still exists and that its proof command still fails on the past mistake. Drop a row once its mistake can no longer happen, and delete the instruction text it made redundant.

Completion criterion: every row names an enforcer that exists and a proof that was observed.

## Reply

Lead with anything that needs the user: exceptions awaiting approval, classes you could not enforce. Then, per class: the evidence, the level picked and why a higher level did not work, the proof (commands and observed outcomes), and the commit. End with the rows you added or dropped.
