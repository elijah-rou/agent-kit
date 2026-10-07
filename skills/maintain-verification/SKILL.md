---
name: maintain-verification
description: Audit and repair a repository's verification skill and feature map under `.agents/skills/verify-<app>/`, with one read-only source reader per feature, one live pass that drives every feature, triage into doc drift, harness gap, or product gap, and an outcome of clean, changed, or blocked. Use when the user invokes maintain-verification or asks to audit the verify skill. Not for creating one; use create-verification.
disable-model-invocation: true
---

# Maintain a verification skill

A feature map rots as soon as the app changes. Cover every feature file from source and drive every feature live; the unit of rigor is the feature, not each sentence.

## Outcome

End with exactly one, and say which:

- **clean:** every feature had source and live coverage, and nothing needs changing. No branch.
- **changed:** one commit series of proven corrections on one branch.
- **blocked:** coverage could not finish, or a proven fix could not land safely. Say exactly what blocked it.

## Edit scope

Edit only the verification skill's own directory: its `SKILL.md`, `features/`, and the helpers it owns. Never edit product code. A behavior the map describes that the app no longer has is either doc drift (fix the map) or a product regression (report it; never paper over it in the docs).

## Pass

0. **Locate the target.** Find the skill under `.agents/skills/verify-*/`. With several candidates, ask which one, recommending the one whose surface the user's request names. With none, stop and point to `create-verification`.

1. **Index hygiene.** Read `features/README.md` and list its sibling files. Fix missing, extra, duplicate, or dead entries, and check that each feature file has its four sections.

2. **Source wave.** Spawn one read-only subagent per feature file, concurrently, using a role or type without write or shell-mutation tools. Each explains how the feature works from source, flags likely drift with `file:line` citations, and returns one live-verification recipe. Children never drive the app, never edit files, and never publish. Return shape: feature summary, source entry points, likely drift or `none`, one recipe. If subagents are unavailable, read each feature yourself and say so.

3. **Reconcile.** Every feature file has a returned summary. Merge recipes into as few app states as practical. Spot-check cited drift; do not re-prove clean claims. Scan recent changes for user-facing surfaces missing from the map, and call one missing only with a concrete source path.

4. **Live pass.** Required even when the source looks clean. Only you drive the app, following the skill's own Launch model: one long-lived instance driven serially for servers and UIs, or a fresh isolated session per drive for short-lived CLIs. Drive every feature at least once. Hold three invariants throughout, whatever fails:
   1. **Health before driving.** Run Doctor before the first drive, on each fresh session, and after any failed drive. When Doctor cannot see the failure (a wedged UI on a healthy process), reset to a known state or relaunch.
   2. **Evidence survives cleanup.** Check the named evidence location after every cleanup; do not assume.
   3. **Nothing outlives its use.** Clean up each drive's residue whether the session is stuck, exited, or shared. For a shared instance, clean the residue, not the instance.

   A Doctor failure caused by skill drift is drift: fix it within edit scope and retry once, restarting only what the fix invalidated, before calling the pass blocked. A feature is `verified-unreachable` only with the concrete missing prerequisite (auth, entitlement, OS, hardware, external state) and the route attempted; a prerequisite the map omits is drift. Re-drive every harness fix live before keeping it. Final teardown happens after the last drive, including re-proofs.

5. **Triage** each finding:
   - **Doc drift:** the user-POV description is wrong or missing. Fix the map.
   - **Harness gap:** working behavior the harness cannot drive. Fix the harness; shipped scripts are executable and their invocation is in the skill body.
   - **Product gap:** the app is actually broken. Record it for the user with its evidence; keep it out of the corrections.

6. **Land or stop.** For `changed`, re-read every changed file, recheck the index and sections, and commit on one branch. Publish only within the repository's autonomy level: at A2 or above, push an `agent/*` branch and open one pull request; below A2, or when the level is unknown, leave the branch for the user. For `clean` or `blocked`, change nothing and report.

Keep run notes (features covered, unreachable prerequisites, confirmed drift) in a scratch location outside the repository; do not commit them.

## Reply

Lead with product gaps and anything blocked. Then the outcome, coverage per feature (source and live, with evidence paths), drift fixed, harness fixes and their re-proofs, the linter output, and the branch or pull request if any.
