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

test("the shared patterns' refusals and narrowings hold in Pi", () => {
  const saved = { child: process.env.PI_SUBAGENT_CHILD, agent: process.env.PI_SUBAGENT_CHILD_AGENT };
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    const root = interceptor();
    for (const command of ["git commit --no-verify -m x", "cd repo && git -C x commit -m y --no-verify"]) {
      assert.equal(root(command)?.block, true, command);
      assert.match(root(command).reason, /^git-interceptor: git guard blocked skipping git hooks with --no-verify/);
    }
    for (const command of ["git merge --no-verify-signatures topic", "git commit -F /tmp/msg"]) assert.equal(root(command), undefined, command);
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_CHILD_AGENT = "deep";
    const run = interceptor();
    for (const command of ["git merge-base HEAD origin/main", "git tag -l", "git tag --contains HEAD", "git tag"]) assert.equal(run(command), undefined, command);
    assert.match(run("git tag v1")?.reason, /child publication\/integration command: git tag/);
  } finally {
    for (const [key, value] of [["PI_SUBAGENT_CHILD", saved.child], ["PI_SUBAGENT_CHILD_AGENT", saved.agent]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Pi refuses -n, skip variables, hooks overrides, gh pr merge, and git by absolute path", () => {
  const saved = { child: process.env.PI_SUBAGENT_CHILD, agent: process.env.PI_SUBAGENT_CHILD_AGENT };
  try {
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    const root = interceptor();
    for (const [command, reason] of [["git commit -nm x", /skipping git hooks with -n/], ["SKIP=lint git commit -m x", /skip variable/], ["git config core.hooksPath /dev/null", /core\.hooksPath or a hook\.\* key/], ["/usr/bin/git commit --no-verify -m x", /--no-verify/]]) {
      assert.equal(root(command)?.block, true, command);
      assert.match(root(command).reason, reason, command);
    }
    for (const command of ["gh pr merge 3", "/usr/bin/git push origin main", "git config user.name x"]) assert.equal(root(command), undefined, command);
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_CHILD_AGENT = "deep";
    const run = interceptor();
    assert.match(run("gh pr merge 3")?.reason, /child publication\/integration command: gh pr merge/);
    assert.match(run("/usr/bin/git push origin agent/x")?.reason, /child publication\/integration command: git push/);
    for (const command of ["gh pr view 3", "git merge-base a b"]) assert.equal(run(command), undefined, command);
  } finally {
    for (const [key, value] of [["PI_SUBAGENT_CHILD", saved.child], ["PI_SUBAGENT_CHILD_AGENT", saved.agent]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the interceptor blocks a command it cannot check, for every actor", () => {
  const original = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    let handler;
    register({ on(event, callback) { if (event === "tool_call") handler = callback; } });
    const throwing = handler({ toolName: "bash", input: { get command() { throw new Error("boom"); } } });
    assert.equal(throwing?.block, true);
    assert.match(throwing.reason, /could not check this command \(boom\)/);
  } finally {
    if (original !== undefined) process.env.PI_SUBAGENT_CHILD = original;
  }
});

test("root execution is not blocked when child marker is absent", () => {
  const original = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    const run = interceptor();
    assert.equal(run("git push origin main"), undefined);
    assert.equal(run("git merge topic"), undefined);
    // Non-git commands the guard has no reason to read pass, including a shell fed from a pipe or started with no input.
    for (const command of ["printf 'echo hi\\n' | sh", "bash -l"]) assert.equal(run(command), undefined, command);
  } finally {
    if (original !== undefined) process.env.PI_SUBAGENT_CHILD = original;
  }
});

test("outward-facing actions follow the standing default and publication stays with the coordinating agent", () => {
  assert.match(agents, /In a repository the user owns[^\n]*push `agent\/\*` branches, open pull requests ready for review/);
  for (const text of [agents, claude]) {
    assert.match(text, /Merging and landing happen only in a mode the user invokes for a run, and the user's own words in the conversation are the invocation: "autopilot", "land these", or "ship it" start a merging mode, and only words such as "stack them, I'll land" start the one that leaves landing to the user\. The autopilot-stack mode[^\n]*the ship mode also lands the contiguous verified run/);
  }
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
  for (const rule of [/Decide and report\. Under a mode the user invoked or the standing default, make each call they cover, act on it, and report it/, /For a call only the user can make[^\n]*apply a default, keep working, and report the default with what the user could tell you to do instead/, /give no reply words to type back and no offer to continue/, /never hand them a check or command you could run yourself/, /One-way doors still wait for the user's review of the shape/, /open with a "Needs you" part/, /offer to run `correct` on it/, /One-way doors are the only pre-build checkpoint/, /The learning loop is the one reviewed path/, /A decision is settled only when the user made or approved it/, /Take the narrowest reading of a user's remark/, /name the directory for any command the user must run/]) {
    assert.match(agents, rule);
    assert.match(claude, rule);
  }
  // The decide-and-report contract replaced the question contract; a product call no longer stops the run.
  for (const text of [agents, claude]) {
    assert.doesNotMatch(text, /Every question gives concrete options/);
    assert.doesNotMatch(text, /unresolved product, public-contract/);
  }
});
