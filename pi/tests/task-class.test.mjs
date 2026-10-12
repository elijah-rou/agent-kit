import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register, { taskRoute } from "../extensions/task-class.ts";
import { digestQuestion, POLICY, QUESTIONS } from "../../agentic/tools/jev/route.ts";

const DOOR = {
  type: "choice", choice: "one-way-door", confidence: 0.99,
  probabilities: { reversible: 0, experiment: 0.01, "one-way-door": 0.99 },
};
const RIGOR = { type: "choice", choice: "rigor", confidence: 0.98, probabilities: { lookup: 0.01, rigor: 0.98, loop: 0.01 } };
// The shipped policy delivers no note, so delivery is tested with an advisory door note.
const DOOR_ADVISORY = {
  ...POLICY,
  notes: { ...POLICY.notes, door: { mode: "advisory", calibration: { threshold: 0.8, questionsDigest: digestQuestion(QUESTIONS.door), model: "jev-1.13.0", samples: 180, positives: 60, precision: 0.78, recall: 0.93, date: "2026-10-07", source: "test" } } },
};

// Drives the extension the way Pi does: input with the typed text, then the turn's start.
// The extension reads the ledger location and the child flag from the process environment.
function fixture({ classifier = {}, child = false, gate = undefined, policy = DOOR_ADVISORY } = {}) {
  const state = mkdtempSync(join(tmpdir(), "pi-route-state-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-route-cwd-"));
  const requests = [];
  const sent = [];
  const registry = {
    findOfType: (type, provider, model) => (type === "classifier" && provider === "typesafe" && model === "jev-latest" && classifier !== null ? { id: model, ...classifier } : undefined),
    classify: async (_model, context) => {
      requests.push(context);
      if (gate) await gate;
      return { model: "jev-latest", answers: { door: DOOR, level: RIGOR }, stopReason: "stop" };
    },
  };
  const handlers = new Map();
  (policy === POLICY ? register : taskRoute(policy))({ on: (name, handler) => handlers.set(name, handler), sendMessage: (message, options) => sent.push({ message, options }) });
  const ctx = { cwd, modelRegistry: registry, sessionManager: { getSessionId: () => "pi-session" } };
  const withEnv = async (work) => {
    const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, AGENTIC_ROUTE: process.env.AGENTIC_ROUTE };
    process.env.XDG_STATE_HOME = state;
    delete process.env.AGENTIC_ROUTE;
    if (child) process.env.PI_SUBAGENT_CHILD = "1"; else delete process.env.PI_SUBAGENT_CHILD;
    try {
      return await work();
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  const input = (text, fields = {}) => withEnv(() => handlers.get("input")({ type: "input", text, source: "interactive", ...fields }, ctx));
  const start = (prompt) => withEnv(() => handlers.get("before_agent_start")({ prompt, systemPrompt: "BASE" }, ctx));
  const records = () => {
    const root = join(state, "agentic", "task-route");
    return readdirSync(root).flatMap((machine) => readdirSync(join(root, machine)).flatMap((file) => readFileSync(join(root, machine, file), "utf8").trimEnd().split("\n").map((line) => ({ file, ...JSON.parse(line) }))));
  };
  return { input, start, requests, sent, records };
}

const MIGRATE = "Migrate the ledger store to SQLite and convert old rows";

test("a typed prompt's note arrives at its turn as a visible message, and the prompt is recorded", async () => {
  const { input, start, requests, records } = fixture();
  assert.deepEqual(await input(MIGRATE), { action: "continue" });
  const result = await start(MIGRATE);
  assert.equal(result.systemPrompt, undefined);
  assert.equal(result.message.customType, "agent-kit/task-route");
  assert.equal(result.message.display, true);
  assert.match(result.message.content, /^Task-class hint, advisory: Jev classifies it as a one-way door \(confidence 0\.99\)\./);
  assert.equal(await start(MIGRATE), undefined, "a note is delivered once");
  assert.deepEqual(requests.map((r) => [r.state, Object.keys(r.questions)]), [[{ task: MIGRATE }, ["door", "level"]]]);
  const [record] = records();
  assert.equal(record.file, "pi-pi-session.jsonl");
  assert.deepEqual([record.runtime, record.repo, record.noted, record.answers.model], ["pi", "none", true, "jev-latest"]);
});

test("a T3 wake-up arriving as input is recorded as system and never sent", async () => {
  const { input, start, requests, records } = fixture();
  const wakeUp = "Delegated task node:delegated-task:x reached a terminal state. Use task_status with taskId x to read the result.";
  await input(wakeUp, { source: "rpc" });
  assert.equal(await start(wakeUp), undefined);
  assert.equal(requests.length, 0);
  assert.deepEqual(records().map((r) => [r.fallbacks, r.noted]), [[["system"], false]]);
});

test("the shipped policy records the door answer and delivers no note", async () => {
  const { input, start, records } = fixture({ policy: POLICY });
  await input(MIGRATE);
  assert.equal(await start(MIGRATE), undefined);
  const [record] = records();
  assert.deepEqual([record.advised.door?.choice, record.delivered, record.noted], ["one-way-door", { level: "rigor" }, false]);
});

test("a prompt queued while the agent works is recorded without a note, so nothing is drained ahead of it", async () => {
  const { input, start, sent, records } = fixture();
  await input(MIGRATE, { streamingBehavior: "steer" });
  assert.equal(sent.length, 0);
  assert.equal(await start(MIGRATE), undefined);
  assert.deepEqual(records().map((r) => [r.fallbacks, r.noted]), [[["queued"], false]]);
});

test("a note reaches only its own prompt's turn, and any later input replaces it", async () => {
  const { input, start } = fixture();
  await input(MIGRATE);
  assert.equal(await start("an unrelated turn started by another extension"), undefined);
  assert.equal(await start(MIGRATE), undefined, "the waiting note was taken by the turn that started");
  await input(MIGRATE);
  await input("/worktree start the parser rewrite in a fresh tree");
  assert.equal(await start(MIGRATE), undefined, "a command's input replaced the note, so a turn whose expansion matches gets nothing");
  const other = "Rename the export command's flags and update the docs";
  await input(MIGRATE);
  await input(other);
  assert.equal(await start(MIGRATE), undefined);
});

test("an older input that finishes routing after a newer one cannot hand its note to the newer one's turn", async () => {
  let release;
  const { input, start } = fixture({ gate: new Promise((resolve) => (release = resolve)) });
  const slow = input(MIGRATE);
  await input("/worktree");
  release();
  await slow;
  assert.equal(await start(MIGRATE), undefined, "the typed command's turn, expanding to the older text, gets no note");
});

test("a typed command, skill or template, is the user's choice: only its arguments are classified, and nothing is delivered", async () => {
  const { input, start, requests, records } = fixture();
  await input("/skill:background-run keep fixing the flaky tests until CI is green");
  assert.equal(await start("EXPANDED SKILL"), undefined);
  await input("/worktree start the parser rewrite in a fresh tree");
  assert.equal(await start("EXPANDED TEMPLATE"), undefined);
  assert.deepEqual(requests.map((r) => r.state), [{ task: "keep fixing the flaky tests until CI is green" }, { task: "start the parser rewrite in a fresh tree" }]);
  assert.deepEqual(records().map((r) => [r.explicit, r.fallbacks]), [["background-run", ["explicit-choice"]], ["other", ["explicit-choice"]]]);
});

test("without a TypeSafe classifier, from a child session, or from another extension, nothing is sent and the record says why", async () => {
  const cases = [
    [fixture({ classifier: null }), {}, "classifier-unavailable"],
    [fixture({ child: true }), {}, "child"],
    [fixture(), { source: "extension" }, "extension"],
  ];
  for (const [{ input, start, requests, records }, fields, reason] of cases) {
    await input(MIGRATE, fields);
    assert.equal(await start(MIGRATE), undefined);
    assert.equal(requests.length, 0, reason);
    assert.deepEqual(records().map((r) => r.fallbacks), [[reason]]);
  }
});
