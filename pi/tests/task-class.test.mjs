import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register, { typedPrompt } from "../extensions/task-class.ts";

const DOOR = {
  type: "choice", choice: "one-way-door", confidence: 0.99,
  probabilities: { reversible: 0, experiment: 0.01, "one-way-door": 0.99 },
};
const RIGOR = { type: "choice", choice: "rigor", confidence: 0.98, probabilities: { lookup: 0.01, rigor: 0.98, loop: 0.01 } };

// The extension reads the ledger location and child flag from the process environment.
function fixture({ classifier = {}, answers = { door: DOOR, level: RIGOR }, child = false } = {}) {
  const state = mkdtempSync(join(tmpdir(), "pi-route-state-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-route-cwd-"));
  const requests = [];
  const registry = {
    findOfType: (type, provider, model) => (type === "classifier" && provider === "typesafe" && model === "jev-latest" && classifier !== null ? { id: model, ...classifier } : undefined),
    classify: async (_model, context) => (requests.push(context), { model: "jev-latest", answers, stopReason: "stop" }),
  };
  const handlers = new Map();
  register({ on: (name, handler) => handlers.set(name, handler) });
  const start = async (prompt) => {
    const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, AGENTIC_ROUTE: process.env.AGENTIC_ROUTE };
    process.env.XDG_STATE_HOME = state;
    delete process.env.AGENTIC_ROUTE;
    if (child) process.env.PI_SUBAGENT_CHILD = "1"; else delete process.env.PI_SUBAGENT_CHILD;
    try {
      return await handlers.get("before_agent_start")({ prompt, systemPrompt: "BASE" }, { cwd, modelRegistry: registry, sessionManager: { getSessionId: () => "pi-session" } });
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  const records = () => {
    const root = join(state, "agentic", "task-route");
    return readdirSync(root).flatMap((machine) => readdirSync(join(root, machine)).flatMap((file) => readFileSync(join(root, machine, file), "utf8").trimEnd().split("\n").map((line) => ({ file, ...JSON.parse(line) }))));
  };
  return { start, requests, records };
}

const MIGRATE = "Migrate the ledger store to SQLite and convert old rows";

test("a door answer arrives as a visible message, the system prompt is untouched, and the prompt is recorded", async () => {
  const { start, requests, records } = fixture();
  const result = await start(MIGRATE);
  assert.equal(result.systemPrompt, undefined);
  assert.equal(result.message.customType, "agent-kit/task-route");
  assert.equal(result.message.display, true);
  assert.match(result.message.content, /^Task-class hint, advisory: Jev classifies it as a one-way door \(confidence 0\.99\)\./);
  assert.deepEqual(requests.map((r) => [r.state, Object.keys(r.questions)]), [[{ task: MIGRATE }, ["door", "level"]]]);
  const [record] = records();
  assert.equal(record.file, "pi-pi-session.jsonl");
  assert.deepEqual([record.runtime, record.repo, record.noted, record.answers.model], ["pi", "none", true, "jev-latest"]);
});

test("without a TypeSafe classifier in the registry there is no message, and the record says why", async () => {
  const { start, requests, records } = fixture({ classifier: null });
  assert.equal(await start(MIGRATE), undefined);
  assert.equal(requests.length, 0);
  assert.deepEqual(records().map((r) => r.fallbacks), [["classifier-unavailable"]]);
});

test("a child session is recorded but never classified", async () => {
  const { start, requests, records } = fixture({ child: true });
  assert.equal(await start(MIGRATE), undefined);
  assert.equal(requests.length, 0);
  assert.deepEqual(records().map((r) => r.fallbacks), [["child"]]);
});

test("an expanded skill command counts as the user's choice: its arguments are classified and nothing is delivered", async () => {
  const expanded = '<skill name="background-run" location="/kit/skills/background-run/SKILL.md">\nReferences are relative to /kit.\n\nBODY\n</skill>\n\nkeep fixing the flaky tests until CI is green';
  assert.equal(typedPrompt(expanded), "/skill:background-run keep fixing the flaky tests until CI is green");
  assert.equal(typedPrompt(MIGRATE), MIGRATE);
  const { start, requests, records } = fixture();
  assert.equal(await start(expanded), undefined);
  assert.deepEqual(requests.map((r) => r.state), [{ task: "keep fixing the flaky tests until CI is green" }]);
  const [record] = records();
  assert.equal(record.explicit, "skill:background-run");
  assert.deepEqual(record.fallbacks, ["explicit-choice"]);
});
