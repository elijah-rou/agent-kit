---
name: repo-baseline
description: Set up or adopt a repository's baseline with an idempotent script - a local git repository, .gitignore, README, license, AGENTS.md naming the one validate command, and that validate entry point - and report the secret-scan hook, remote, CI, ruleset, and Jev opt-out decisions. Use when a new project starts, or when a repository lacks git, AGENTS.md, a validate command, or a license. Not for adding a remote, CI, or a ruleset on its own, which needs the user's authorization (rulesets are github-rulesets).
---

# Repo baseline

Every project stands on the same floor: a local git repository (always), a `.gitignore` for its stack, a README, a license when one is named or implied, `AGENTS.md` with the repository's conventions and its one validate command, and that validate entry point. A remote, CI, and a ruleset are never set up by default.

`scripts/baseline.ts` in this skill's directory audits and applies the baseline. Run it with Bun from anywhere; it acts on the directory you pass. It never overwrites or edits an existing file, creates nothing outside that directory, and never touches a remote, so rerunning it is always safe.

## 1. Audit

```sh
bun <this skill's directory>/scripts/baseline.ts audit <repository root>
```

Each item gets one status: `present`; `create` (apply will create it); `manual` (a gap in an existing file, or a missing input; the detail says what); `decision` (the user's call, with the default); `optional` (case by case, never by default). `--json` gives the same report structured.

If `git` is `manual`, the directory sits inside another repository. Apply refuses there. Ask the user whether this project is the outer repository or a new nested one, recommending the outer one unless the user said this is a separate project.

Completion criterion: you have the report, and nothing changed.

## 2. Settle the inputs

- **License.** Pass `--license MIT` when the user named MIT. A manifest that declares MIT gets its LICENSE without the flag. For another license the user named or the manifest declares, write its canonical text yourself (`gh api licenses/<key> -q .body`, then fill in the year and holder). Otherwise create none, and do not stop to ask: report the proposed default, MIT, as the user's to change. The holder is `--holder` or `git config user.name`.
- **`CLAUDE.md`.** Pass `--claude-md` when the project is worked on by a runtime that reads `CLAUDE.md` instead of `AGENTS.md`. The file holds only the line `@AGENTS.md`, so `AGENTS.md` stays the one source of instructions.
- **Secret-scan hook.** Pass `--secret-hook` only when the user asked for one. With no hook manager it writes a pre-commit config that runs gitleaks. Where a hook manager exists, audit already reports whether it scans for secrets.
- **Validate.** The script builds `scripts/validate` only from commands the repository already has: its just recipes and make targets, its package scripts, and the stack's standard tools where the configuration shows them. If none exist, the item stays `manual`. Never add a linter, test framework, or type checker to fill it; rerun apply once the first slice adds tests.

Completion criterion: each flag you pass traces to the user's words or the project's own files.

## 3. Apply

```sh
bun <this skill's directory>/scripts/baseline.ts apply <repository root> [--license MIT] [--holder NAME] [--claude-md] [--secret-hook]
```

It runs `git init -b main` when there is no repository, creates every `create` item, and prints the audit again. A second run creates nothing. Then:

1. Replace the README's marked line with what the project does and for whom, from the conversation. Audit reports the stub until you do.
2. Add the conventions the user has stated (language, layout, naming, commit style) to `AGENTS.md`, briefly. Keep facts a reader can find in the code out of it.
3. Run the validate command once and report its result. In an adopted repository a failing validate is a finding to report, not a reason to change its commands.
4. After `--secret-hook`, run `pre-commit install` if pre-commit is installed; otherwise report that it is needed.
5. Read the diff and commit the baseline as one commit.

Completion criterion: audit shows no `create` items, and the README is no longer the stub.

## 4. Close the manual items

The script reports gaps in existing files and leaves the edits to you. Make them as ordinary local changes: add the missing `.gitignore` patterns; name the validate command in `AGENTS.md`; move instructions that live only in `CLAUDE.md` into `AGENTS.md` and reduce `CLAUDE.md` to `@AGENTS.md`; add a gitleaks hook to the existing hook manager. For CI that does not run the validate command, propose the change to the user along with step 5.

Completion criterion: every `manual` item is fixed or listed in your report with the reason it is open.

## 5. Remote, CI, and ruleset, case by case

None of these happens by default. Each needs the user's authorization naming the operation and the repository. Ask once, as one question, with your recommendation, and default to staying local until the user answers:

- **Remote:** create the GitHub repository under the user's account and push `main` (`gh repo create <name> --private --source <repository root> --remote origin --push`). Visibility is the user's call, and private is the default.
- **CI:** one workflow that checks out the code, installs the toolchain, and runs the validate command, with actions pinned to commit SHAs. Land it through a pull request.
- **Ruleset:** apply the `baseline` tier right after the first push, as `github-rulesets` describes, in the same authorization as creating the repository.

Completion criterion: each of the three is done with the user's authorization, or reported as not set up.

## 6. Jev opt-out

Whether to opt the repository out of Jev's prompt routing is the user's call, and the default is not opted out. Do not ask before going on; report it with the default. If the user opts out, commit an empty `.agents/jev-opt-out`, and no prompt from the repository is sent.

## Report

What apply created; the validate command and its result; the `manual` items fixed or still open; and the decisions with their defaults: license (proposed MIT unless named or declared), Jev opt-out (not opted out), and remote, CI, and ruleset (not set up).
