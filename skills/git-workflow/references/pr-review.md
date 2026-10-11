# Adversarial pull-request review

One fresh reviewer tries to break each change before it is published and applies the repository's review rules, so no person has to remember them on every pull request.

## When

Before opening a pull request, or marking a draft ready, whose diff changes code, configuration, or agent instructions. After a later push that changes its behavior, run a focused re-review of what changed. A rebase with no conflicts or a formatting-only change needs none; a conflict resolution does.

In `autopilot-full`, an owner opens its pull request early by design and does not spawn reviewers. The coordinator's verification round provides this review through its audit lane, before merge.

## Run it

1. **Scope:** the diff against the base branch.
2. **Intent:** one paragraph from the task, the commits, and the pull request body. The reviewer challenges the execution, not the intent.
3. **Rules:** the repository's review rules, meaning `rules.toml` rows at level `review` and judgment rules in its agent instruction files. Write `none` when there are none.
4. **Spawn** one read-only reviewer that did not write the change, on a different model family from the author where available, with the brief below filled in. When only the author's family is available, say so in the testing notes. Elevated risk adds a second reviewer with a different question, as the instructions require.
5. **Judge** each finding yourself: accept it, or dismiss it with a concrete reason. Fix accepted blocking findings in one pass, rerun the affected checks, and run a focused re-review of the fix.
6. **Record** in the pull request's testing notes that the review ran, on which model, and any finding left open for the user.

Completion criterion: the reviewer returned, every blocking finding is fixed or listed in the pull request body as open, and the testing notes say so.

## Reviewer brief

> You are an adversarial reviewer. Find problems in this change that would block accepting it. Do not edit files, commit, or publish. Read the surrounding code (callers, callees, types) before judging.
>
> **Intent:** {INTENT}. Assume the goal is right; challenge the execution.
> **Change:** {the diff, or the repository path with base and head}
> **Repository review rules:** {RULES, or none}
>
> Use the lenses that apply; a small fix does not need every lens.
>
> - **Correctness:** edge cases, error handling, state, reruns after a partial failure, concurrent access. Trace the call chain that triggers a bug instead of saying it could happen.
> - **Root cause:** guards that mask a broken invariant, retries that hide a broken contract, casts that silence a modeling error, a workaround where the proper fix belongs in another module.
> - **Precedent:** the next contributor copies what this change shows. Flag a second way to do something that already has one, a workaround an agent would repeat, internals reachable from outside their module, a compatibility path with no external consumer, and a rule left as prose where a type, lint, or check could hold it.
> - **Verification:** a behavior change with no proof on the surface it affects, tests that would still pass if the code returned nothing, checks of a proxy instead of the real value.
> - **Complexity:** abstractions with one caller, options for cases that do not exist, dead code.
> - **Security:** untrusted input traced to a dangerous sink (shell, SQL, eval, HTML), secrets in code, logs, or errors, missing authorization.
> - **Review rules:** each violation cites the rule's id.
>
> Report only blocking findings, each with its location (file:line), why it is wrong, and how to show it fails (an input, a scenario, or a command). Then at most three non-blocking notes, one line each. "No blocking findings" is a valid review. Do not praise or restate the code.
