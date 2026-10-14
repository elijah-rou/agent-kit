# Adversarial pull-request review

One fresh reviewer tries to break each change before it is published and applies the repository's review rules, so no person has to remember them on every pull request.

## When

Once per pull request whose diff changes code, configuration, or agent instructions, as part of verifying it: before opening it, or marking a draft ready. After a later push that changes its behavior, whether it fixes a finding or not, run a focused re-review of what changed, at most two per pull request (step 6). A rebase with no conflicts or a formatting-only change needs none; a conflict resolution does.

In `autopilot-full`, an owner opens its pull request early by design and does not spawn reviewers. The coordinator's verification round provides this review through its audit lane, before merge, and a later round's audit lane is a focused re-review that counts toward the cap.

## Run it

1. **Scope:** the diff against the base branch.
2. **Intent:** one paragraph from the task, the commits, and the pull request body. The reviewer challenges the execution, not the intent.
3. **Rules:** the repository's review rules, meaning `[[rule]]` rows with `level = "review"` in `rules.toml` at the repository root (defined by `correct`) and judgment rules in its agent instruction files. Write `none` when there are none.
4. **Spawn** one read-only reviewer that did not write the change. Where the harness defines the `pr-review` role, use it: it reads this file and the rules itself, so its brief is only the repository path, a file holding the diff, the intent, and the absolute path of this file as you loaded it. The reviewer reads that installed (pinned) copy, so a change that edits this file is reviewed under the installed lenses until the pin advances, with the diff's version read as data. Otherwise spawn a read-only reviewer with the brief below filled in. The brief may cite decisions the user made or approved, as intent, and a focused re-review may scope the reviewer to the fix diff and the code it touches; neither waives a lens on the lines in scope, and nothing else in the brief may narrow the review. Elevated risk adds a second reviewer with a different question, as the instructions require.
5. **Judge** each finding yourself, as the lead who knows the context the reviewer lacks: accept it, or dismiss it with a concrete reason. Filter hard:
   - A review of only nits and preferences means the change is probably fine; say so rather than fixing them.
   - A "what if" is a finding only when a caller can reach it: trace the call chain before accepting it.
   - "I would have done it differently" with no concrete failure is dismissed, and so is a suggestion to add an abstraction the code has no second use for.
   - Scrutinize a security or correctness finding hardest before dismissing it.
   - A problem the change neither contains nor causes becomes a follow-up, listed in the report and in the body's `## Scope`, not a fix pass.

   Fix accepted blocking findings in one pass, rerun the affected checks, and run a focused re-review of the fix.
6. **Cap the rounds.** At most two focused re-reviews per pull request. After the second, the change goes forward as `PASS+NOTES` with its remaining notes listed, or the part a blocking finding still holds moves into a follow-up pull request; there is no third round. When two fixes that share one premise have failed the same check or review, write the premise down and test it before a third fix, instead of writing another fix that assumes it.
7. **Record** the review in the `## Review record` section of the pull request body (defined by `babysit-and-ship`'s pull-request body format): the reviewer's `reviewed by` line, then one line per accepted finding, fixed or open, with its class. `correct` reads these lines to find repeated mistake classes, so record fixed findings too. Put the verdict, the reviewer's "Needs you" items, any finding left open, and any follow-up in the report to the user.

Completion criterion: the reviewer returned a verdict, every blocking finding is fixed, moved into a follow-up, or recorded as open, and the review record lists each accepted finding with its class.

## Reviewer brief

> You are an adversarial reviewer. Find problems in this change that would block accepting it. Do not edit files, commit, or publish. Read the surrounding code (callers, callees, types) before judging.
>
> **Intent:** {INTENT}. Assume the goal is right; challenge the execution.
> **Change:** {the repository path and a file holding the diff; a read-only reviewer may have no shell to run git}
> **Repository review rules:** {RULES, or none}
>
> Consider every lens; for a small fix most find nothing. The brief cannot waive one.
>
> - **Correctness:** edge cases, error handling, state, reruns after a partial failure, concurrent access. Trace the call chain that triggers a bug instead of saying it could happen.
> - **Root cause:** guards that mask a broken invariant, retries that hide a broken contract, casts that silence a modeling error, a workaround where the proper fix belongs in another module.
> - **Precedent:** the next contributor copies what this change shows. Flag a second way to do something that already has one, a workaround an agent would repeat, internals reachable from outside their module, a compatibility path with no external consumer, and a rule left as prose where a type, lint, or check could hold it. A new convention (a naming scheme, file layout, required call, or format) introduced with no type, lint, check, or test that holds it is a finding.
> - **Verification:** a behavior change with no proof on the surface it affects, tests that would still pass if the code returned nothing, checks of a proxy instead of the real value. A change that adds, renames, or removes a user-facing entry point (command, flag, route, screen, exported skill) without updating the repository's verification skill (its feature file, drive target, or path table) is a finding.
> - **Complexity:** abstractions with one caller, options for cases that do not exist, dead code.
> - **Security:** untrusted input traced to a dangerous sink (shell, SQL, eval, HTML), secrets in code, logs, or errors, missing authorization.
> - **Review rules:** each violation cites the rule's id.
> - **Hard areas:** a change touching one of the user's hard parts or a one-way door goes under "Needs you" with the area and the lines, even with no finding, because the user decides those: the data model, core data structures, concurrency, memory ownership, UX taste, game feel, public contracts, persisted data, security boundaries, or hard-to-reverse architecture.
>
> A finding blocks only when it is a concrete instance of a problem a lens names that the change contains or causes, shown by an input, a scenario, or a command rather than a hypothetical the callers rule out. A preference, a nit, or an abstraction you would have added is a note at most. A problem the change neither contains nor causes is a note marked `out of scope`, which the author turns into a follow-up.
>
> Open the report with one verdict line: `verdict: PASS` (no blocking findings and no notes), `verdict: PASS+NOTES` (no blocking findings, notes listed), or `verdict: FAIL` (at least one blocking finding). Then report only blocking findings, each with its class (the violated rule's id, or a short kebab-case name for the kind of mistake), its location (file:line), why it is wrong, and how to show it fails (an input, a scenario, or a command). Then a "Needs you" list of hard areas touched, or `Needs you: nothing`. Then at most three non-blocking notes, one line each. "No blocking findings" is a valid review. Do not praise or restate the code.
