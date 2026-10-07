import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
const gitWorkflow = await readFile(new URL("../../skills/git-workflow/SKILL.md", import.meta.url), "utf8");
const claude = await readFile(new URL("../../claude/CLAUDE.md", import.meta.url), "utf8");
const gatePolicies = await readFile(new URL("../../agentic/policy/global.cedar", import.meta.url), "utf8");
const worktrees = await readFile(new URL("../extensions/worktrees.ts", import.meta.url), "utf8");

test("outward-facing actions follow the autonomy level and publication stays with the coordinating agent", () => {
  assert.match(agents, /A0, no grant: anything outward-facing \(pushing, publishing, posting, changing shared or remote systems\) needs explicit authorization/);
  assert.match(agents, /A2: also push `agent\/\*` branches, open pull requests ready for review/);
  assert.match(agents, /At every level, explicit authorization is still required for destructive actions[^\n]*deploys and releases, messages to people/);
  assert.match(agents, /never treat a defaulted answer as approval/);
  assert.match(gitWorkflow, /Pushing and merging follow the repository's autonomy level/);
  assert.match(gitWorkflow, /Name every branch you intend to push `agent\/<topic>`/);
  assert.match(agents, /The parent owns planning, decisions, acceptance, and outward-facing actions/);
  assert.match(agents, /`git-workflow` for worktrees, history, pushing, merging, and pull requests/);
  assert.match(gitWorkflow, /Only the coordinating agent may push, merge[^\n]*Subagents and external mutation-capable runners never do/);
  assert.match(gitWorkflow, /recheck the exact revision and the full workspace against the final verification/i);
  assert.match(agents, /Write a short ADR only for public contracts, persisted formats, security boundaries, major dependencies, hard-to-reverse architecture, or substantial operational commitments/i);
});

test("worktree gardening reports at exact thresholds and never auto-removes", () => {
  assert.match(worktrees, /REPOSITORY_GARDENING_THRESHOLD = 6/);
  assert.match(worktrees, /GLOBAL_GARDENING_THRESHOLD = 12/);
  assert.match(worktrees, />= GLOBAL_GARDENING_THRESHOLD/);
  assert.match(worktrees, />= REPOSITORY_GARDENING_THRESHOLD/);
  assert.match(worktrees, /Removal is never automatic/);
});

test("both harnesses carry the same autonomy ladder and interaction contract, matching the gate", () => {
  const ladder = (text) => text.match(/^- Decide routine reversible things[\s\S]*?draft the command for the user\.$/m)?.[0];
  assert.ok(ladder(agents));
  assert.equal(ladder(claude), ladder(agents));
  for (const rule of [/Every question gives concrete options, a recommendation with its reason, and the default/, /open with a "Needs you" part/, /offer to run `correct` on it/, /One-way doors are the only pre-build checkpoint/, /The learning loop is the one reviewed path/]) {
    assert.match(agents, rule);
    assert.match(claude, rule);
  }
  assert.match(gatePolicies, /resource\.name like "agent\/\*" && context\.effectiveLevel >= 2/);
});
