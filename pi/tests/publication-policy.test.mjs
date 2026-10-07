import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import register from "../extensions/git-interceptor.ts";

const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
const gitWorkflow = await readFile(new URL("../../skills/git-workflow/SKILL.md", import.meta.url), "utf8");
const claude = await readFile(new URL("../../claude/CLAUDE.md", import.meta.url), "utf8");
const worktrees = await readFile(new URL("../extensions/worktrees.ts", import.meta.url), "utf8");

function interceptor() {
  let handler;
  register({ on(event, callback) { if (event === "tool_call") handler = callback; } });
  return (command) => handler({ toolName: "bash", input: { command } });
}

test("marked children cannot publish or integrate with Git", () => {
  const original = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const run = interceptor();
    for (const command of ["git push origin main", "git merge topic", "git rebase main", "git cherry-pick HEAD~1", "git -C /tmp/repo pull"]) {
      assert.equal(run(command)?.block, true, command);
      assert.match(run(command).reason, /child publication\/integration/);
    }
    for (const command of ["git status --short", "git diff --check", "git log -1", "git show HEAD", "git commit -m local"]) assert.equal(run(command), undefined, command);
  } finally {
    if (original === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = original;
  }
});

test("an autopilot-full owner child may publish its own pull request; other roles may not", () => {
  const saved = { child: process.env.PI_SUBAGENT_CHILD, agent: process.env.PI_SUBAGENT_CHILD_AGENT };
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    process.env.PI_SUBAGENT_CHILD_AGENT = "autopilot-owner";
    const owner = interceptor();
    for (const command of ["git push --force-with-lease origin agent/x", "git rebase origin/main", "git pull --ff-only"]) assert.equal(owner(command), undefined, command);
    assert.equal(owner("git commit --no-verify -m x")?.block, true);
    process.env.PI_SUBAGENT_CHILD_AGENT = "deep";
    assert.equal(interceptor()("git push origin agent/x")?.block, true);
  } finally {
    for (const [key, value] of [["PI_SUBAGENT_CHILD", saved.child], ["PI_SUBAGENT_CHILD_AGENT", saved.agent]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("root execution is not blocked when child marker is absent", () => {
  const original = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    const run = interceptor();
    assert.equal(run("git push origin main"), undefined);
    assert.equal(run("git merge topic"), undefined);
  } finally {
    if (original !== undefined) process.env.PI_SUBAGENT_CHILD = original;
  }
});

test("outward-facing actions follow the standing default and publication stays with the coordinating agent", () => {
  assert.match(agents, /In a repository the user owns[^\n]*push `agent\/\*` branches, open pull requests ready for review/);
  assert.match(agents, /Merging and landing happen only in a mode the user invokes for a run: the autopilot-stack mode[^\n]*the ship mode also lands the contiguous verified run/);
  assert.match(agents, /In any other repository, anything outward-facing \(pushing, publishing, posting, changing shared or remote systems\) needs explicit authorization/);
  assert.match(agents, /explicit authorization is still required for destructive actions[^\n]*deploys and releases, messages to people/);
  assert.match(agents, /never treat a defaulted answer as approval/);
  assert.match(gitWorkflow, /Merging, pushing to the default branch, force-pushing or deleting shared branches, and any push to a repository the user does not own require explicit authorization/);
  assert.match(gitWorkflow, /Name every branch you intend to push `agent\/<topic>`/);
  assert.match(agents, /The parent owns planning, decisions, acceptance, and outward-facing actions/);
  assert.match(agents, /`git-workflow` for worktrees, history, pushing, merging, and pull requests/);
  assert.match(gitWorkflow, /except an `autopilot-full` owner for its own `agent\/\*` branch and pull request/);
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

test("both harnesses carry the same standing default and interaction contract", () => {
  const ladder = (text) => text.match(/^- Decide routine reversible things[\s\S]*?draft the command for the user\.$/m)?.[0];
  assert.ok(ladder(agents));
  assert.equal(ladder(claude), ladder(agents));
  for (const rule of [/Every question gives concrete options, a recommendation with its reason, and the default/, /open with a "Needs you" part/, /offer to run `correct` on it/, /One-way doors are the only pre-build checkpoint/, /The learning loop is the one reviewed path/, /A decision is settled only when the user made or approved it/, /Take the narrowest reading of a user's remark/, /name the directory for any command the user must run/]) {
    assert.match(agents, rule);
    assert.match(claude, rule);
  }
});
