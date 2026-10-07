import assert from "node:assert/strict";
import test from "node:test";
import register from "../extensions/report-contract.ts";

const longBody = "Changed the parser and its tests. ".repeat(15);
const run = (report) => [{ role: "user", content: "fix it" }, { role: "toolResult", content: "ok" }, { role: "assistant", content: [{ type: "text", text: report }] }];

function extension() {
  const handlers = {};
  const notes = [];
  const entries = [];
  register({ on: (event, handler) => { handlers[event] = handler; }, appendEntry: (type, data) => entries.push([type, data]) });
  const ctx = { hasUI: true, ui: { notify: (message, level) => notes.push([level, message]) }, sessionManager: { getBranch: () => [] } };
  handlers.session_start({}, ctx);
  return { handlers, notes, entries, ctx };
}

test("a substantial report without a Needs you part warns; a compliant one and conversation do not", () => {
  const e = extension();
  e.handlers.agent_end({ messages: run(`## Summary\n${longBody}`) }, e.ctx);
  assert.equal(e.notes.length, 1);
  assert.match(e.notes[0][1], /interaction contract/);
  e.handlers.agent_end({ messages: run(`Needs you: nothing\n\n## Summary\n${longBody}`) }, e.ctx);
  e.handlers.agent_end({ messages: [{ role: "assistant", content: longBody }] }, e.ctx);
  assert.equal(e.notes.length, 1);
});

test("the reflection reminder fires once the turn cadence is reached and then resets", () => {
  const e = extension();
  for (let i = 0; i < 10; i++) e.handlers.turn_end({}, e.ctx);
  e.handlers.agent_end({ messages: [] }, e.ctx);
  assert.match(e.notes.at(-1)[1], /reflection is due/);
  assert.equal(e.entries.at(-1)[1].turnsSinceLast, 0);
});
