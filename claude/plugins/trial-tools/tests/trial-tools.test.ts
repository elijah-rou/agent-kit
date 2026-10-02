import { expect, test } from "claude-code/testing";
import type { CommandRunInput, SessionMessage, TurnCompleteInput } from "claude-code";
import { formatThread, MAX_COPY_CHARS, MAX_THREAD_ROWS, throughput, tpsLabel } from "../hooks/register.js";

// The native test runner provides console; the hooks-only SDK globals omit it.
declare const console: { log: (message: string) => void };

const completed = {
  turnId: "main", reason: "answer", answer: "done", durationMs: 8000, isAborted: false,
  usage: { model: "test", input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
} satisfies TurnCompleteInput;
const row: SessionMessage = { role: "user", text: "hello", toolUses: [] };

function command(name: string, args = ""): CommandRunInput {
  return { command: name, args, origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 80 } };
}

test("clip copies text without quoting its contents", async ($, on) => {
  let copied = "";
  on("ui.copy", (_$, event) => { copied = event.text; return { value: { isCopied: true } }; });
  const result = await $.command.run(command("clip", "hello"));
  expect(result.exitCode).toBe(0);
  expect(copied).toBe("hello");
  expect(result.text).not.toContain("hello");
});

test("clip reads only an explicit @path and reports clipboard rejection", async ($, on) => {
  const reads: string[] = [];
  on("fs.read", (_$, event) => { reads.push(event.path); return { value: "file content\n" }; });
  on("ui.copy", () => ({ value: { isCopied: false, reason: "no-surface" } }));
  expect((await $.command.run(command("clip", "@notes.md"))).exitCode).toBe(1);
  expect(reads.length).toBe(1);
  expect(reads[0]).toMatch(/notes\.md$/);
});

test("clip bounds text and rejects empty arguments before copying", async ($, on) => {
  let calls = 0;
  on("ui.copy", () => { calls++; return { value: { isCopied: true } }; });
  for (const args of ["", "   ", "@", "@  ", "x".repeat(MAX_COPY_CHARS + 1)]) {
    expect((await $.command.run(command("clip", args))).exitCode).toBe(1);
  }
  expect(calls).toBe(0);
  expect((await $.command.run(command("clip", "x".repeat(MAX_COPY_CHARS)))).exitCode).toBe(0);
  expect(calls).toBe(1);
});

test("copy-all copies only visible user and assistant text", async ($, on) => {
  let copied = "";
  on("session.messages", () => ({ value: [row, { role: "assistant", text: "answer", toolUses: [{ tool_use_id: "read-1", tool: "Read", input: { path: "secret" } }] }] }));
  on("ui.copy", (_$, event) => { copied = event.text; return { value: { isCopied: true } }; });
  expect((await $.command.run(command("copy-all"))).exitCode).toBe(0);
  expect(copied).toBe("## user\n\nhello\n\n## assistant\n\nanswer\n");
  expect(copied).not.toContain("secret");
});

test("clipboard API failures do not fall through or report success", async ($, on) => {
  let calls = 0;
  on("ui.copy", () => { calls++; return { deny: "failed" }; });
  expect((await $.command.run(command("clip", "hello"))).exitCode).toBe(1);
  expect(calls).toBe(1);
});

test("clipboard commands refuse programmatic and unclassified origins before reading", async ($, on) => {
  let reads = 0;
  let copies = 0;
  on("fs.read", () => { reads++; return { value: "secret" }; });
  on("ui.copy", () => { copies++; return { value: { isCopied: true } }; });
  const request = command("clip", "@notes.md");
  for (const origin of [{ kind: "plugin", name: "other" }, { kind: "peer" }, { kind: "unclassified" }] as const) {
    expect((await $.command.run({ ...request, origin })).exitCode).toBe(1);
  }
  expect(reads).toBe(0);
  expect(copies).toBe(0);
});

test("session startup registers the four direct commands without starting a turn", async ($, on) => {
  const names: string[] = [];
  on("session.start", () => ({ cwd: "/work" }));
  on("command.register", (_$, event) => { names.push(event.name); return { value: { command: event.name } }; });
  await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
  expect(names).toEqual(["clip", "copy-all", "changes", "tps"]);
});

test("thread formatting refuses ambiguous truncation and oversized content", () => {
  expect(formatThread([])).toBe("");
  expect(formatThread([{ ...row, text: "   " }])).toBe("");
  expect(formatThread(Array.from({ length: MAX_THREAD_ROWS - 1 }, () => row))).toContain("hello");
  expect(() => formatThread(Array.from({ length: MAX_THREAD_ROWS }, () => row))).toThrow();
  expect(() => formatThread(Array.from({ length: MAX_THREAD_ROWS + 1 }, () => row))).toThrow();
  expect(formatThread([{ ...row, text: "x".repeat(MAX_COPY_CHARS - 10) }]).length).toBe(MAX_COPY_CHARS);
  expect(() => formatThread([{ ...row, text: "x".repeat(MAX_COPY_CHARS - 9) }])).toThrow();
});

test("changes uses bounded read-only Git argv with external helpers disabled", async ($, on) => {
  const recorded: string[][] = [];
  on("session.cwd", () => ({ value: "/work" }));
  on("process.run", (_$, event) => {
    recorded.push([...event.argv]);
    expect(event.init?.cwd).toBe("/work");
    expect(event.init?.timeoutMs).toBe(5000);
    return { value: { exitCode: 0, stdout: event.argv.includes("rev-parse") ? "/work\n" : "result\n", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  const result = await $.command.run(command("changes"));
  expect(result.exitCode).toBe(0);
  expect(result.text).toContain("## Recent commits");
  expect(recorded.length).toBe(6);
  console.log("TRIAL_TOOLS_GIT_ARGS=" + JSON.stringify(recorded));
  for (const args of recorded) {
    expect(args.slice(0, 9)).toEqual(["git", "--no-pager", "--no-optional-locks", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"]);
    expect(args.includes("push") || args.includes("commit") || args.includes("merge")).toBe(false);
    if (args.includes("diff")) expect(args).toContain("--no-ext-diff");
    if (args.includes("diff")) expect(args).toContain("--no-textconv");
    if (args.includes("log")) expect(args).toContain("--no-show-signature");
  }
});

test("changes reports Git failures and output truncation", async ($, on) => {
  let exitCode = 1;
  let isStdoutTruncated = false;
  on("session.cwd", () => ({ value: "/work" }));
  on("process.run", () => ({ value: { exitCode, stdout: "partial", stderr: "", isStdoutTruncated, isStderrTruncated: false } }));
  expect((await $.command.run(command("changes"))).exitCode).toBe(1);
  exitCode = 0;
  isStdoutTruncated = true;
  expect((await $.command.run(command("changes"))).exitCode).toBe(1);
});

test("TPS is turn throughput, handles interruption, and rejects invalid measurements", () => {
  expect(tpsLabel(undefined)).toBe("out tok/s: idle");
  expect(tpsLabel(throughput(completed))).toBe("out tok/s 125.0 (1000)");
  expect(tpsLabel(throughput({ ...completed, reason: "aborted", isAborted: true }))).toContain("interrupted");
  expect(tpsLabel(throughput({ ...completed, usage: undefined }))).toBe("out tok/s: n/a");
  for (const durationMs of [0, -1, 0.5, NaN, Infinity, null, undefined, "8", true]) {
    expect(throughput({ ...completed, durationMs } as unknown as TurnCompleteInput)).toEqual({ phase: "unavailable" });
  }
  for (const output_tokens of [-1, 0.5, NaN, Infinity, null, undefined, "1", true, Number.MAX_SAFE_INTEGER + 1]) {
    expect(throughput({ ...completed, usage: { ...completed.usage, output_tokens } } as unknown as TurnCompleteInput)).toEqual({ phase: "unavailable" });
  }
  expect(tpsLabel(throughput({ ...completed, usage: { ...completed.usage, output_tokens: 0 } }))).toBe("out tok/s 0.0 (0)");
});

test("TPS ignores subagents and stale main completions", async ($, on) => {
  on("turn.start", (_$, event) => ({ turnId: event.turnId }));
  on("turn.complete", () => ({ text: "" }));
  await $.turn.start({ turnId: "main", text: "go" });
  expect((await $.command.run(command("tps"))).text).toContain("working");
  await $.turn.complete({ ...completed, agentId: "child" });
  await $.turn.complete({ ...completed, turnId: "old" });
  expect((await $.command.run(command("tps"))).text).toContain("working");
  await $.turn.complete(completed);
  expect((await $.command.run(command("tps"))).text).toBe("out tok/s 125.0 (1000)");
});

test("TPS draws on terminal and desktop and preserves the existing band", async ($, on) => {
  on("turn.start", (_$, event) => ({ turnId: event.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["existing band"] }));
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ plugin: "trial-tools", surface, component: "AbovePrompt", props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } });
    expect(await ui.find({ type: "Text", text: "existing band" })).toBeDefined();
    await $.turn.start({ turnId: "main", text: "go" });
    expect(await ui.find({ type: "Text", text: "out tok/s: working" })).toBeDefined();
    await $.turn.complete(completed);
    expect(await ui.find({ type: "Text", text: "out tok/s 125.0 (1000)" })).toBeDefined();
    await ui.unmount();
  }
});
