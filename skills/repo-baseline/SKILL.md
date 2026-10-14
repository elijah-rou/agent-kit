---
name: repo-baseline
description: Set up or adopt a repository's baseline with an idempotent script - a local git repository, .gitignore, README, license, AGENTS.md naming the one validate command, and that validate entry point - and report the secret-scan hook, remote, CI, ruleset, and Jev opt-out decisions. Use when a new project starts, or when a repository lacks git, AGENTS.md, a validate command, or a license. Not for adding a remote, CI, or a ruleset on its own, which needs the user's authorization (rulesets are github-rulesets).
---

# Repo baseline

Every project stands on the same floor: a local git repository (always), a `.gitignore` for its stack, a README, a license when one is named or implied, `AGENTS.md` with the repository's conventions and its one validate command, and that validate entry point. A remote, CI, and a ruleset are never set up by default.

`scripts/baseline.ts` in this skill's directory audits and applies the baseline. Run it with Bun from anywhere; it acts on the directory you pass. It never overwrites or edits an existing file, creates nothing outside that directory, and never touches a remote, so rerunning it is always safe. It creates each file by hard-linking a finished temporary file into place, so the directory must be on a filesystem that supports hard links; elsewhere apply stops with an error and leaves no temporary file.

## 1. Audit

```sh
bun <this skill's directory>/scripts/baseline.ts audit <repository root>
```

Each item gets one status: `present`; `create` (apply will create it); `manual` (a gap in an existing file, or a missing input; the detail says what); `decision` (the user's call, with the default); `optional` (case by case, never by default). `--json` gives the same report structured.

If `git` is `manual`, the directory sits inside another repository, and apply refuses there. Ask the user whether this project belongs to the outer repository or is a new nested one, recommending the outer one unless the user said this is a separate project. Until the user answers, take the outer repository: rerun audit at its root. A new nested repository means running `git init -b main` in the subdirectory first; then apply works there.

Completion criterion: you have the report, and nothing changed.

## 2. Settle the inputs

- **License.** Pass `--license MIT` when the user named MIT. A manifest that declares MIT gets its LICENSE without the flag. For another license the user named or the manifest declares, write its canonical text yourself (`gh api licenses/<key> -q .body`, then fill in the year and holder). Otherwise create none, and do not stop to ask: report the proposed default, MIT, as the user's to change. The holder is `--holder` if given, otherwise the manifest's author. With neither, `--license MIT` falls back to `git config user.name`, and a manifest's MIT leaves license a `decision`: ask the user who holds the copyright and pass `--holder`, never the name of whoever runs the script.
- **`CLAUDE.md`.** Pass `--claude-md` when the project is worked on by a runtime that reads `CLAUDE.md` instead of `AGENTS.md`. Only this flag creates it, never a `.claude/` folder's presence. The file holds only the line `@AGENTS.md`, so `AGENTS.md` stays the one source of instructions. Where `AGENTS.md` is missing but instructions already live in another file an agent runtime loads (`CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.override.md`, or a project `SYSTEM.md` or `APPEND_SYSTEM.md`; the script lists them), apply creates neither a template `AGENTS.md` nor a root `CLAUDE.md`, and reports `agents-md` as `manual`.
- **Secret-scan hook.** Pass `--secret-hook` only when the user asked for one. With no hook manager it writes a pre-commit config that runs gitleaks. Where a hook manager exists, audit already reports whether it scans for secrets.
- **Validate.** The script builds `scripts/validate` only from commands the repository already has: its just recipes and make targets for lint, type checks, and tests, run by name; its package scripts; and a stack's tool only where the repository configures it (plain `cargo clippy` where a clippy config, a clippy lints table, or a crate-level clippy attribute exists; mypy with the files its configuration names). It never copies a command out of CI, a makefile, or a justfile. A `cargo clippy` or `go vet` those files run but nothing configures is a `validate-gap` item: add it to `scripts/validate` by hand if the repository wants it locally. If no command exists, the item stays `manual`. Never add a linter, test framework, or type checker to fill it; rerun apply once the first slice adds tests.

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

The script reports gaps in existing files and leaves the edits to you. Make them as ordinary local changes: add the missing `.gitignore` patterns; name the validate command in `AGENTS.md`; move the shared instructions that live only in `CLAUDE.md` or `.claude/CLAUDE.md` into `AGENTS.md` and reduce that file to its import (`@AGENTS.md` at the root, `@../AGENTS.md` in `.claude/`), leaving personal or runtime-only files such as `CLAUDE.local.md` and a system-prompt file in place; add a gitleaks hook to the existing hook manager. For CI that does not run the validate command, propose the change to the user along with step 5.

Completion criterion: every `manual` item is fixed or listed in your report with the reason it is open.

## 5. Remote, CI, and ruleset, case by case

None of these happens by default. Each needs the user's authorization naming the operation and the repository. Ask once, as one question, with your recommendation, and default to staying local until the user answers:

- **Remote:** create the GitHub repository under the user's account and push `main` (`gh repo create <name> --private --source <repository root> --remote origin --push`). Visibility is the user's call, and private is the default.
- **CI:** one workflow that checks out the code, installs the toolchain, and runs the validate command, with actions pinned to commit SHAs. Land it through a pull request.
- **Ruleset:** apply the `agentic-backstop` ruleset right after the first push, as `github-rulesets` describes, in the same authorization as creating the repository.

Completion criterion: each of the three is done with the user's authorization, or reported as not set up.

## 6. Jev opt-out

Whether to opt the repository out of Jev's prompt routing is the user's call, and the default is not opted out. Do not ask before going on; report it with the default. If the user opts out, commit an empty `.agents/jev-opt-out`, and no prompt from the repository is sent.

## Report

What apply created; the validate command and its result; the `manual` items fixed or still open; and the decisions with their defaults: license (proposed MIT unless named or declared), Jev opt-out (not opted out), and remote, CI, and ruleset (not set up).
