import type { EngineInterface, Register, SessionMessage, TurnCompleteInput } from "claude-code";
import type { TpsState } from "../types/index.js";

export const MAX_COPY_CHARS = 1_048_576;
export const MAX_THREAD_ROWS = 4096;
const MAX_GIT_CHARS = 32_768;
const TPS = { plugin: "trial-tools", key: "tps" } as const;

export function formatThread(messages: readonly SessionMessage[]): string {
  if (messages.length >= MAX_THREAD_ROWS) throw new Error("Thread reaches the native row limit; export it instead.");
  const parts: string[] = [];
  let length = 0;
  for (const message of messages) {
    if (!message.text.trim()) continue;
    const part = `## ${message.role}\n\n${message.text}\n`;
    length += part.length;
    if (length > MAX_COPY_CHARS) throw new Error("Thread exceeds the clipboard size limit.");
    parts.push(part);
  }
  const text = parts.join("\n");
  if (text.length > MAX_COPY_CHARS) throw new Error("Thread exceeds the clipboard size limit.");
  return text;
}

export function throughput(event: TurnCompleteInput): TpsState {
  const outputTokens = event.usage?.output_tokens;
  if (!Number.isSafeInteger(outputTokens) || outputTokens === undefined || outputTokens < 0) return { phase: "unavailable" };
  if (!Number.isSafeInteger(event.durationMs) || event.durationMs <= 0) return { phase: "unavailable" };
  return { phase: "complete", outputTokens, durationMs: event.durationMs, interrupted: event.isAborted };
}

export function tpsLabel(state: TpsState | undefined): string {
  if (state === undefined) return "out tok/s: idle";
  switch (state.phase) {
    case "working": return "out tok/s: working";
    case "unavailable": return "out tok/s: n/a";
    case "complete": {
      const rate = state.outputTokens * 1000 / state.durationMs;
      return `out tok/s ${rate.toFixed(1)} (${state.outputTokens}${state.interrupted ? ", interrupted" : ""})`;
    }
    default: {
      const impossible: never = state;
      throw new Error(`Unknown throughput state: ${String(impossible)}`);
    }
  }
}

async function copyText($: EngineInterface, text: string) {
  if (!text.length) return { text: "Nothing to copy.", exitCode: 1 };
  if (text.length > MAX_COPY_CHARS) return { text: "Clipboard input exceeds the 1 Mi-character limit.", exitCode: 1 };
  const result = await $.ui.copy({ text });
  return result.isCopied
    ? { text: "Copied to clipboard.", exitCode: 0 }
    : { text: "Clipboard unavailable on this surface; use an interactive terminal or desktop session.", exitCode: 1 };
}

async function git($: EngineInterface, cwd: string, args: readonly string[]): Promise<string> {
  const result = await $.process.run(["git", "--no-pager", "--no-optional-locks", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", ...args], { cwd, timeoutMs: 5000 });
  if (result.exitCode !== 0) throw new Error("Git inspection failed; check the repository and Git installation.");
  if (result.isStdoutTruncated || result.stdout.length > MAX_GIT_CHARS) throw new Error("Git inspection exceeds the display limit; inspect it in the terminal.");
  return result.stdout.replace(/\r?\n$/, "") || "none";
}

export const register: Register = (on) => {
  on("session.start", async ($, event, next) => {
    const result = await next(event);
    await $.command.register({ name: "clip", description: "Copy text or @file contents to the clipboard", argumentHint: "text | @path" });
    await $.command.register({ name: "copy-all", description: "Copy this thread's user/assistant text to the clipboard" });
    await $.command.register({ name: "changes", description: "Read-only Git status, diff stats, untracked files, and recent commits" });
    await $.command.register({ name: "tps", description: "Show last turn's output tokens per wall-clock second", immediate: true });
    return result;
  });

  on("command.run", { command: "clip" }, async ($, event) => {
    if (!["composer", "bridge", "sdk"].includes(event.origin.kind)) return { text: "Clipboard commands require a direct user or CLI invocation.", exitCode: 1 };
    const input = event.args.trim();
    if (!input) return { text: "Usage: /clip text or /clip @path", exitCode: 1 };
    if (input.startsWith("@")) {
      const path = input.slice(1).trim();
      if (!path) return { text: "Usage: /clip @path", exitCode: 1 };
      return copyText($, await $.fs.read(path));
    }
    return copyText($, input);
  }).catch(() => ({ text: "Copy failed; no clipboard update was confirmed.", exitCode: 1 }));

  on("command.run", { command: "copy-all" }, async ($, event) => {
    if (!["composer", "bridge", "sdk"].includes(event.origin.kind)) return { text: "Clipboard commands require a direct user or CLI invocation.", exitCode: 1 };
    if (event.args.trim()) return { text: "Usage: /copy-all", exitCode: 1 };
    return copyText($, formatThread(await $.session.messages()));
  }).catch(() => ({ text: "Thread copy failed; no clipboard update was confirmed. Check thread size and clipboard availability.", exitCode: 1 }));

  on("command.run", { command: "changes" }, async ($, event) => {
    if (event.args.trim()) return { text: "Usage: /changes", exitCode: 1 };
    const cwd = await $.session.cwd();
    const root = await git($, cwd, ["rev-parse", "--show-toplevel"]);
    const sections = [
      "# Changes", `Repo: ${root}`,
      "\n## Status", await git($, cwd, ["status", "--short", "--untracked-files=normal"]),
      "\n## Staged diff stat", await git($, cwd, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--stat"]),
      "\n## Unstaged diff stat", await git($, cwd, ["diff", "--no-ext-diff", "--no-textconv", "--stat"]),
      "\n## Untracked files", await git($, cwd, ["ls-files", "--others", "--exclude-standard"]),
      "\n## Recent commits", await git($, cwd, ["log", "--no-show-signature", "--oneline", "-5"]),
    ];
    const text = sections.join("\n");
    if (text.length > MAX_GIT_CHARS) return { text: "Git summary exceeds the display limit; inspect it in the terminal.", exitCode: 1 };
    return { text, exitCode: 0 };
  }).catch(() => ({ text: "Git inspection failed; check the repository, Git installation, and output size.", exitCode: 1 }));

  on("turn.start", async ($, event, next) => {
    const result = await next(event);
    await $.state.set(TPS, { phase: "working", turnId: event.turnId });
    return result;
  });

  on("turn.complete", async ($, event, next) => {
    const result = await next(event);
    if (event.agentId !== undefined) return result;
    const held = await $.state.get(TPS);
    if (held.value?.phase !== "working" || held.value.turnId !== event.turnId) return result;
    await $.state.set(TPS, throughput(event), { ifVersion: held.version });
    return result;
  });

  on("command.run", { command: "tps" }, async ($, event) => {
    if (event.args.trim()) return { text: "Usage: /tps", exitCode: 1 };
    return { text: tpsLabel((await $.state.get(TPS)).value), exitCode: 0 };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, event, next) => {
    if (event.props.hasSurvey || event.props.view?.agentId !== undefined) return next(event);
    const label = tpsLabel((await $.state.get(TPS)).value);
    const base = await next(event);
    const { Box, Text } = $.ui.resolve(event);
    return Box({ flexDirection: "column", children: [base, Text({ dimColor: true, children: label })] });
  });
};
