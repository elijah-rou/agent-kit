import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import register from "../extensions/agentic-policy-gate.ts";

const root = mkdtempSync(join(tmpdir(), "agentic-gate-"));
after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const repo = join(root, "repo");
mkdirSync(home);
mkdirSync(repo);
writeFileSync(join(home, "grants.toml"), '[[grant]]\nrepo = "github.com/example/app"\nlevel = 2\n');
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
git("init", "--quiet", "--initial-branch=main");
git("remote", "add", "origin", "git@github.com:example/app.git");

function gate() {
  const handlers = {};
  register({ on(event, callback) { handlers[event] = callback; }, registerCommand() {}, appendEntry() {} });
  const ctx = { cwd: repo, hasUI: false, sessionManager: { getBranch: () => [], getSessionId: () => "test" } };
  return (toolName, input) => handlers.tool_call({ toolName, input }, ctx);
}

test("the gate blocks hard points, protects control files, and stays out of ordinary calls", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { AGENTIC_HOME: home, AGENTIC_JEV_THRESHOLD: "", AGENTIC_NO_KEYCHAIN: "1" });
  delete process.env.AGENTIC_GRANTS;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.AGENTIC_CHILD;
  try {
    const run = gate();
    const push = await run("bash", { command: "git push origin main" });
    assert.equal(push?.block, true);
    assert.match(push.reason, /always-pause-default-branch/);
    assert.match(push.reason, /needs the user's approval/);
    const grants = await run("edit", { path: join(home, "grants.toml"), oldText: "level = 2", newText: "level = 4" });
    assert.equal(grants?.block, true);
    assert.match(grants.reason, /protect-control-files/);
    assert.equal(await run("bash", { command: "ls -la" }), undefined);
    assert.equal(await run("bash", { command: "git push origin agent/topic" }), undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
