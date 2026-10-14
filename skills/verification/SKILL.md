---
name: verification
description: Select and exercise the affected behavior or integration boundary, tie evidence to the tested workspace and keep it free of account identifiers and secrets, run the repository's validate command before every push, and separate worker feedback from parent acceptance. Use for code behavior changes, defects, reliability claims, integrations, and final acceptance. Simple prose or preference edits need their focused artifact or consumer check, not a separate verification workflow.
---

# Verification

Choose evidence for the claim, not a fixed ceremony. Global and repository instructions own authorization and completion policy; this skill explains how to exercise the affected boundary.

## Select the boundary

Identify the intended outcome, changed workspace, affected runtime surfaces, risks, and required repository checks. Use the strongest necessary practical boundary:

1. parse, lint, type, policy, or artifact checks;
2. focused behavior or defect reproduction;
3. controlled materialization and integration;
4. runtime user or service journey;
5. bounded performance, concurrency, fuzz, or flake sampling;
6. authorized read-only installed or production observation.

A parser cannot prove a setting is consumed. A stubbed integration can prove control flow but not external service compatibility or real latency. State those distinctions rather than inflating the claim. Avoid unrelated suites and repeat checks only after relevant changes, failures, or material evidence gaps, or when the repository requires them.

When the repository has a verification skill under `.agents/skills/verify-*/`, use it for every runtime journey: drive the change through its commands, cover each entry point its `features/` map lists for the affected feature, and keep evidence where it says. When the map lacks the affected feature, drive it through the skill's launch and doctor with the closest recipe, and report the missing map entry. A throwaway script you write around its control CLI to do what the CLI cannot (build and run the tests in its environment, repeat a check to sample a flaky failure, compare its toolchain with CI's) is a harness gap: finish the check with it, then report the gap and what the script did. When you find a harness gap or a missing map entry, offer `maintain-verification` under "Needs you" so the user can run it. That user-invoked pass brings the verify skill up to the current contract; do not migrate the verify skill or run that workflow as part of your task. Verify on the surface the change affects. A check on another surface, or an inconclusive one, is not a pass; report it as such.

## Establish the problem before the fix

Define expected behavior and inventory existing coverage before production edits. For defects, reuse the smallest reproducer or add one durable case, observe RED, implement the causal fix, then observe GREEN. If no check or journey reproduces the symptom, continue diagnosis or report the gap without speculative production changes.

For other code behavior changes, add problem-first coverage only for uncovered behavior and invariants. Adequately covered refactors add no tests. Mechanical preference/config edits need a parse or actual consumer check, not a manufactured failing snapshot. Behavioral and security-sensitive configuration changes use the same evidence standards as code.

For new or changed deterministic input contracts, retain only relevant distinguishable rows: accepted values, limits, one step outside, absent input, explicit `undefined`, `null`, non-finite and fractional values, wrong primitive types, and the transition from valid to invalid data. Each retained row needs executable evidence, which may already exist. Do not change expectations solely to agree with an implementation.

A reproducible command or runtime journey can substitute for a conventional test. Implementation-first work is a regression check, not TDD. Performance and reliability claims need a baseline and the same journey afterward.

When you write, change, or keep a test, read `references/test-behavior-not-implementation.md` first. A test that pins required phrases in instruction or skill files is a deliberate contract test, not a restated prompt string. Before you trust, report, or act on a number you measured (a speedup, latency, throughput, or eval result), read `references/explain-the-number.md`. To time a whole command (a CLI, script, build, or test suite), read `references/command-benchmarks.md`.

## Validate before every push

Every repository has one local validate entry point, and CI runs the same command: the one the repository's `AGENTS.md` names, which `repo-baseline` creates as `scripts/validate`. It is the repository's definition of "the checks pass", so run it rather than assembling its parts yourself.

- Commit first, then run validate on the committed head with a clean worktree, so the result describes a commit rather than uncommitted edits. Note its short SHA (`git rev-parse --short HEAD`) and the outcome.
- Push only a head that validate passed on this host. On a failure, fix it and run validate again. A missing tool is a failure too, not a pass: install it where your authority allows, or do not push and report the head blocked with the missing tool. Only a part of validate that targets another platform (a container or OS the host is not) may be left to CI; name that part in the verification notes.
- Where the repository provides a container mode of validate for another platform its CI covers, run that too when the change could behave differently there (paths, shells, filesystems, native code).
- In the pull request's verification notes, name the command, its outcome, and the short SHA it ran on, and update them for each new head you push.
- CI then confirms the local result. A CI failure on a SHA whose local validate passed is environment or flake until shown otherwise: rerun it once, then diagnose it by comparing the two runs' toolchain versions, platform, and environment before changing code (`babysit-and-ship`'s CI rule).
- A repository with no validate entry point gets one from `repo-baseline`. Until then, run the checks its CI runs and report the missing entry point as a gap.

## Keep evidence free of identifiers and secrets

Verification evidence, logs, receipts, and commit metadata never hold account identifiers (email addresses, Apple IDs and other sign-in names, user home paths, device and private network addresses) or secrets (tokens, keys, cookies, session or authentication dumps). The one exception is a git identity the remote trunk's history already holds, which a push cannot newly expose (below). Drive with test accounts and the run's own home and state directories where the harness allows, and redact a value before quoting it.

- Before committing evidence or a log, scan it: `python3 <this skill's directory>/scripts/scan-public-safety --paths <evidence directory>`. It names each finding's file, line, and kind, never the value. Fix a finding by redacting the source or capturing again, not by leaving the file out of the scan. It reads text only, so look at screenshots and recordings yourself for visible account names.
- Before pushing, scan the commits you add: `python3 <this skill's directory>/scripts/scan-public-safety --commits <trunk>..HEAD`. Fix any other finding before pushing. When the only findings are the author or committer address your git configuration supplies, do not change that configuration or rewrite the commits yourself, and check whether the remote trunk's history already holds that address (`git log <trunk> --format='%ae%n%ce' | grep -Fxq "$(git log -1 --format=%ae)"` exits 0 when it holds the author address; use `%ce` for the committer). If it does, the push exposes nothing new: push, and report it under "Needs you" with the fix, setting `user.email` to the forge's no-reply address. If it does not, do not push: report the branch blocked with that fix.
- The scanner adds to a repository's own secret scanning, such as a pre-commit hook; it does not replace it.

## Accept the integrated result

Workers use the fastest sufficient inner loop. The root parent independently runs and inspects the authoritative affected boundary on the final integrated workspace. Checked child evidence is useful feedback, not runtime proof. Review does not replace this acceptance step.

Keep evidence bound to repository, revision, and the tested changes. Use existing receipt IDs when available; do not introduce receipt machinery just for a simple edit. Treat receipts as immutable attempt facts, not authority. Distinguish assertion failures, execution errors, unsupported tools, cancellations, and timeouts.

Report exercised behavior, inspected artifacts, exact outcomes, and residual gaps. Once the affected checks pass, finish within the authorized scope. When a change needed a runtime journey and the repository has no verification skill, drive the journey with the tools at hand, then report the missing skill as an evidence gap `create-verification` would close. Add a repository-owned runtime adapter only after repeated setup or interaction failures show that it would remove a recurring evidence gap.
