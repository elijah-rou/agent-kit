import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const stripTypeScriptTypes = (source) => new Bun.Transpiler({ loader: "ts" }).transformSync(source);
const source = stripTypeScriptTypes(readFileSync(new URL("../extensions/task-class.ts", import.meta.url), "utf8")
  .replace(/import \{ taskHintFor \} from "[^"]+";/, "")
  .replace("export default function", "function register"));

function fixture(taskHintFor, env = {}) {
  const handlers = new Map();
  const calls = [];
  const register = vm.runInNewContext(`${source}\nregister;`, {
    taskHintFor: async (...args) => { calls.push(args); return taskHintFor(...args); },
    process: { env },
  });
  register({ on: (name, handler) => handlers.set(name, handler) });
  const start = (prompt) => handlers.get("before_agent_start")({ prompt, systemPrompt: "BASE" }, { cwd: "/repo" });
  return { calls, start };
}

test("a hint is appended to the turn's system prompt", async () => {
  const { calls, start } = fixture(async () => "HINT");
  assert.equal((await start("Migrate the ledger to SQLite and convert old rows")).systemPrompt, "BASE\n\nHINT");
  assert.equal(JSON.stringify(calls), JSON.stringify([["Migrate the ledger to SQLite and convert old rows", "/repo"]]));
});

test("no hint, a failure, or a child session leaves the prompt alone", async () => {
  assert.equal(await fixture(async () => undefined).start("Fix the typo in the README introduction"), undefined);
  assert.equal(await fixture(async () => { throw new Error("offline"); }).start("Fix the typo in the README introduction"), undefined);
  const child = fixture(async () => "HINT", { PI_SUBAGENT_CHILD: "1" });
  assert.equal(await child.start("Migrate the ledger to SQLite and convert old rows"), undefined);
  assert.equal(child.calls.length, 0);
});
