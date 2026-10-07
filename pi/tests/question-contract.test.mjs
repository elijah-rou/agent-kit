import assert from "node:assert/strict";
import { mock, test } from "bun:test";

// Only the headless paths run here, so the TUI and schema modules Pi supplies at runtime are stubs.
const schema = () => ({});
mock.module("typebox", () => ({ Type: { Object: schema, String: schema, Array: schema, Optional: schema, Boolean: schema } }));
mock.module("@mariozechner/pi-tui", () => ({ Editor: class {}, Key: {}, matchesKey: () => false, Text: class {}, truncateToWidth: (s) => s, visibleWidth: (s) => s.length, wrapTextWithAnsi: (s) => [s] }));

function tool(module) {
  const tools = new Map();
  module.default({ on() {}, registerTool(t) { tools.set(t.name, t); } });
  return tools;
}

const options = [{ label: "Squash", value: "squash" }, { label: "Rebase", value: "rebase" }];
const contract = { recommendation: "Squash", recommendationReason: "One commit per change.", default: "Squash", defaultAfter: "if no answer this session" };
const headless = { hasUI: false };

test("question rejects a missing recommendation or default and defaults headlessly without approving", async () => {
  const question = tool(await import("../extensions/question.ts")).get("question");
  const rejected = await question.execute("1", { question: "Merge style?", options, ...contract, default: "Merge" }, undefined, undefined, headless);
  assert.match(rejected.content[0].text, /default must be one of the option labels/);
  assert.equal(rejected.details.answer, null);

  const answered = await question.execute("2", { question: "Merge style?", options, ...contract }, undefined, undefined, headless);
  assert.equal(answered.details.answer, "Squash");
  assert.equal(answered.details.defaulted, true);
  assert.match(answered.content[0].text, /not user approval/);
});

test("questionnaire applies the same contract per question", async () => {
  const questionnaire = tool(await import("../extensions/questionnaire.ts")).get("questionnaire");
  const question = { id: "merge", prompt: "Merge style?", options, ...contract, recommendation: "squash", default: "squash" };
  const rejected = await questionnaire.execute("1", { questions: [{ ...question, recommendation: "fast-forward" }] }, undefined, undefined, headless);
  assert.match(rejected.content[0].text, /recommendation must be one of the option values/);

  const answered = await questionnaire.execute("2", { questions: [question] }, undefined, undefined, headless);
  assert.deepEqual(answered.details.answers.map((a) => [a.value, a.defaulted]), [["squash", true]]);
  assert.match(answered.content[0].text, /not user approval/);
});
