import { expect, test } from "claude-code/testing";
import { ACTIONS, INPUT_SCHEMA, parseValidationInput, shellQuote, VALIDATION_TOOL } from "../hooks/validation.js";

function input(action: unknown = "test", extra: Record<string, unknown> = {}) {
  return { tool: VALIDATION_TOOL, action, ...extra };
}
function runner(outcome: string = "passed") {
  return { result: { stdout: JSON.stringify({ outcome, exitCode: outcome === "passed" ? 0 : 7, verificationReceipt: { version: 1 } }), stderr: "", interrupted: false } };
}

test("validation parser accepts defaults, all actions, explicit undefined and limit boundaries", () => {
  expect(parseValidationInput({ action: "test" })).toEqual({ action: "test", command: undefined, cwd: undefined, timeoutMs: 120000 });
  for (const action of ACTIONS) expect(parseValidationInput({ action, command: undefined, cwd: undefined, timeoutMs: undefined }).action).toBe(action);
  for (const timeoutMs of [1000, 120000, 300000]) expect(parseValidationInput({ action: "lint", timeoutMs }).timeoutMs).toBe(timeoutMs);
  expect(parseValidationInput({ action: "typecheck", command: "x".repeat(8192), cwd: "/" + "x".repeat(4095) }).command?.length).toBe(8192);
  expect(INPUT_SCHEMA.properties.timeoutMs.maximum).toBe(300000);
});

test("validation parser rejects distinguishable malformed input before execution", () => {
  for (const value of [undefined, null, false, 1, "test", [], {}]) expect(() => parseValidationInput(value)).toThrow();
  for (const action of [undefined, null, true, 0, "", "build", [], {}]) expect(() => parseValidationInput({ action })).toThrow();
  for (const timeoutMs of [null, false, "1000", [], {}, 0, 999, 300001, 1000.5, NaN, Infinity, -Infinity]) expect(() => parseValidationInput({ action: "test", timeoutMs })).toThrow();
  for (const command of [null, false, 1, [], {}, "", "   ", "x\0y", "x".repeat(8193)]) expect(() => parseValidationInput({ action: "test", command })).toThrow();
  for (const cwd of [null, false, 1, [], {}, "", "   ", "x\0y", "x".repeat(4097)]) expect(() => parseValidationInput({ action: "test", cwd })).toThrow();
  expect(() => parseValidationInput({ action: "test", timeout_ms: 1000 })).toThrow();
  expect(shellQuote("a'b; $(echo nope)\n")).toBe("'a'\\''b; $(echo nope)\n'");
  expect(() => shellQuote("\0")).toThrow();
});

test("validation is registered as a model tool without launching commands", async ($, on) => {
  const names: string[] = [];
  on("session.start", () => ({ cwd: "/work" }));
  on("command.register", (_$, event) => ({ value: { command: event.name } }));
  on("tool.register", (_$, event) => { names.push(event.name); expect(event.inputSchema).toEqual(INPUT_SCHEMA); return { value: { tool: VALIDATION_TOOL } }; });
  await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
  expect(names).toEqual(["project_validate"]);
});

test("validation uses native Bash foreground permission/sandbox path and returns structured failure", async ($, on) => {
  let command = "";
  on("session.cwd", () => ({ value: "/work with spaces" }));
  on("tool.call", { tool: "Bash" }, (_$, event) => {
    command = String(event.command);
    expect(event.timeout).toBe(180000);
    expect(event.run_in_background).toBe(false);
    expect(event.dangerouslyDisableSandbox).toBeUndefined();
    return runner("failed");
  });
  const response = await $.tool.call(input("test", { command: "printf 'error; literal'" }));
  expect(response.isError).toBe(true);
  expect(response.result).toBe(JSON.stringify({ outcome: "failed", exitCode: 7, verificationReceipt: { version: 1 } }));
  expect(command).toContain("'--cwd' '/work with spaces'");
  expect(command).toContain(shellQuote("printf 'error; literal'"));
});

test("validation invalid inputs and denied Bash never execute directly or fabricate receipts", async ($, on) => {
  let calls = 0;
  on("session.cwd", () => ({ value: "/work" }));
  on("tool.call", { tool: "Bash" }, () => { calls++; return { deny: "Bash policy denies this command" }; });
  expect((await $.tool.call(input("build"))).isError).toBe(true);
  expect(calls).toBe(0);
  const response = await $.tool.call(input());
  expect(response.isError).toBe(true);
  expect(response.result).toBe(JSON.stringify({ outcome: "denied", error: "Bash policy denies this command", verificationReceipt: null }));
  expect(calls).toBe(1);
});

test("validation handles cancelled, malformed, error and unsupported native results", async ($, on) => {
  on("session.cwd", () => ({ value: "/work" }));
  let result: unknown = { interrupted: true };
  let isError = false;
  on("tool.call", { tool: "Bash" }, () => isError ? { result, isError: true as const } : { result });
  expect((await $.tool.call(input())).result).toBe(JSON.stringify({ outcome: "cancelled", error: "Native Bash interrupted validation", verificationReceipt: null }));
  for (const value of [null, [], {}, { stdout: "not json" }, { stdout: "null" }, { stdout: JSON.stringify({ outcome: "invented" }) }, { stdout: JSON.stringify({ outcome: "passed", verificationReceipt: { version: 2 } }) }]) {
    result = value;
    expect((await $.tool.call(input())).isError).toBe(true);
  }
  result = { stdout: "{}", interrupted: false };
  isError = true;
  expect((await $.tool.call(input())).isError).toBe(true);
  isError = false;
  result = { stdout: JSON.stringify({ outcome: "cancelled", verificationReceipt: null }) };
  expect((await $.tool.call(input())).result).toBe(JSON.stringify({ outcome: "cancelled", verificationReceipt: null }));
  result = { stdout: JSON.stringify({ outcome: "unsupported", verificationReceipt: { version: 1 } }) };
  expect((await $.tool.call(input())).isError).toBe(true);
});

test("validation stops only its exact native background task and reports failed cleanup", async ($, on) => {
  on("session.cwd", () => ({ value: "/work" }));
  on("tool.call", { tool: "Bash" }, () => ({ result: { backgroundTaskId: "owned-task-1" } }));
  on("tool.call", { tool: "TaskStop" }, (_$, event) => { expect(event.task_id).toBe("owned-task-1"); return { deny: "stop refused" }; });
  const response = await $.tool.call(input());
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.result)).toContain("owned-task-1");
});
