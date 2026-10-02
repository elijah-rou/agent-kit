import type { EngineInterface, On } from "claude-code";

export const VALIDATION_TOOL = "mcp__trial-tools__project_validate";
export const ACTIONS = ["test", "lint", "typecheck"] as const;
type Action = typeof ACTIONS[number];
export type ValidationInput = { action: Action; command?: string; cwd?: string; timeoutMs: number };
const MAX_COMMAND = 8192;
const MAX_CWD = 4096;
const MIN_TIMEOUT = 1000;
const MAX_TIMEOUT = 300000;
const DEFAULT_TIMEOUT = 120000;

export const INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action"],
  properties: {
    action: { type: "string", enum: ACTIONS },
    command: { type: "string", minLength: 1, maxLength: MAX_COMMAND, description: "Explicit non-mutating test/lint/typecheck command. Never install, fix, format-write, deploy, or publish." },
    cwd: { type: "string", minLength: 1, maxLength: MAX_CWD, description: "Project directory; relative paths resolve under the session directory. Explicit commands use this exact directory." },
    timeoutMs: { type: "integer", minimum: MIN_TIMEOUT, maximum: MAX_TIMEOUT, default: DEFAULT_TIMEOUT },
  },
};

export const VALIDATION_SPEC = { name: "project_validate", description: "Run bounded project tests, lint, or typechecks through native Bash permission/sandbox checks, with structured diagnostics and before/after workspace receipts. Prefer an explicit known command; otherwise detect the project runner. Only non-mutating validation: never install, fix, format-write, deploy, publish, or run arbitrary chores. Commands have local user permissions; this is not a read-only sandbox. Receipts are observations, not authority or proof of unchanged ignored dependencies/environment.", inputSchema: INPUT_SCHEMA };

function textParameter(value: unknown, name: string, limit: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) throw new Error(`${name} must be nonempty text of at most ${limit} characters without NUL`);
  return value;
}

export function parseValidationInput(value: unknown): ValidationInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("validation input must be an object");
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find(key => !["action", "command", "cwd", "timeoutMs", "tool", "tool_use_id", "agentId"].includes(key));
  if (unknown !== undefined) throw new Error(`unknown validation field: ${unknown}`);
  const action = ACTIONS.find(candidate => candidate === fields.action);
  if (action === undefined) throw new Error("action must be test, lint, or typecheck");
  const command = textParameter(fields.command, "command", MAX_COMMAND);
  const cwd = textParameter(fields.cwd, "cwd", MAX_CWD);
  const timeoutMs = fields.timeoutMs === undefined ? DEFAULT_TIMEOUT : fields.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT || timeoutMs > MAX_TIMEOUT) throw new Error(`timeoutMs must be an integer in ${MIN_TIMEOUT}..${MAX_TIMEOUT}`);
  return { action, command, cwd, timeoutMs };
}

export function shellQuote(text: string): string {
  if (text.includes("\0")) throw new Error("shell argument contains NUL");
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("native result must be an object");
  return value as Record<string, unknown>;
}

export async function runValidation($: EngineInterface, input: ValidationInput, agentId?: string) {
  const cwd = input.cwd ?? await $.session.cwd();
  const arguments_ = ["python3", `${$.plugin.root}/hooks/project-validate.py`, "--action", input.action, "--cwd", cwd, "--timeout-ms", String(input.timeoutMs), "--actor", agentId === undefined ? "root-or-user" : `subagent:${agentId}`];
  if (input.command !== undefined) arguments_.push("--command", input.command);
  // The built-in tool supplies permission checks and sandboxing; process.run would bypass that path.
  const bash = await $.tool.call({ tool: "Bash", command: arguments_.map(shellQuote).join(" "), timeout: input.timeoutMs + 60000, run_in_background: false, description: `Run bounded project ${input.action} with workspace evidence` });
  if (bash.deny !== undefined) return { outcome: "denied", error: bash.deny, verificationReceipt: null };
  const returned = record(bash.result);
  if (typeof returned.backgroundTaskId === "string") {
    const stopped = await $.tool.call({ tool: "TaskStop", task_id: returned.backgroundTaskId });
    return { outcome: "execution_error", error: "Native Bash backgrounded validation; result not observed", verificationReceipt: null, residualGaps: stopped.deny !== undefined || stopped.isError ? ["Background task stop was refused or failed; inspect the exact task ID", returned.backgroundTaskId] : [] };
  }
  if (returned.interrupted === true) return { outcome: "cancelled", error: "Native Bash interrupted validation", verificationReceipt: null };
  if (bash.isError || typeof returned.stdout !== "string") return { outcome: "execution_error", error: bash.text ?? "Native Bash failed to launch validation", verificationReceipt: null };
  const result = record(JSON.parse(returned.stdout));
  if (!["passed", "failed", "timed_out", "cancelled", "execution_error", "unsupported"].includes(String(result.outcome))) throw new Error("validation runner returned an unknown outcome");
  if (result.outcome !== "execution_error" && result.outcome !== "cancelled" && record(result.verificationReceipt).version !== 1) throw new Error("validation receipt version is unsupported");
  return result;
}

export function registerValidation(on: On): void {
  on("command.run", { command: "validate" }, async ($, event) => {
    try {
      const input = parseValidationInput(JSON.parse(event.args));
      const result = await $.tool.call({ tool: VALIDATION_TOOL, ...input });
      return { text: result.deny === undefined && typeof result.result === "string" ? result.result : JSON.stringify({ outcome: "denied", error: result.deny }), presentation: "text" as const };
    } catch (error) {
      return { text: `trial-tools: /validate requires a JSON object with action test, lint, or typecheck. ${String(error)}`, presentation: "text" as const };
    }
  });
  on("tool.call", { tool: VALIDATION_TOOL }, async ($, event) => {
    let input: ValidationInput;
    try { input = parseValidationInput(event); }
    catch (error) { return { result: JSON.stringify({ outcome: "invalid_input", error: String(error), verificationReceipt: null }), isError: true }; }
    try {
      const result = await runValidation($, input, event.agentId);
      if (result.outcome === "passed") return { result: JSON.stringify(result) };
      return { result: JSON.stringify(result), isError: true as const };
    } catch (error) {
      return { result: JSON.stringify({ outcome: "execution_error", error: String(error), verificationReceipt: null }), isError: true };
    }
  });
}
