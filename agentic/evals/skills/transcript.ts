// Parse a Pi `--mode json` event stream into the facts the grader needs: what the agent
// actually did (tool calls, in order, with results), not what it said it did.
//
// Line numbers refer to the compacted transcript (see compact()), which is the copy kept
// in evals/skills/transcripts/ so evidence pointers survive the gitignored scratch area.

export type ToolCall = {
  /** Order of tool_execution_start among all tool calls, from 0. */
  seq: number;
  /** 1-based line of tool_execution_start in the compacted transcript. */
  line: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean | undefined;
};

export type Usage = { input: number; output: number; cacheRead: number; cost: number };

export type Transcript = {
  cwd: string | undefined;
  systemSections: Record<string, string> | undefined;
  toolCalls: ToolCall[];
  finalText: string;
  finalLine: number | undefined;
  usage: Usage;
  /** Assistant messages that ended with an error stop reason. */
  errors: string[];
};

/** Split on LF only, as Pi's JSON framing requires, and drop empty records. */
export function records(jsonl: string): unknown[] {
  return jsonl
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const DROPPED = new Set(["message_update", "tool_execution_update", "message_start"]);

/**
 * Drop streaming deltas and duplicate copies of messages. Every completed message
 * (message_end) and tool result (tool_execution_end) is kept; turn_end and agent_end keep
 * their position but not the messages they repeat.
 */
export function compact(jsonl: string): string {
  return records(jsonl)
    .filter((r): r is Rec => isRec(r) && !DROPPED.has(String(r.type)))
    .map((r) => {
      if (r.type === "turn_end") return { type: r.type };
      if (r.type === "agent_end") return { type: r.type, willRetry: r.willRetry };
      return r;
    })
    .map((r) => JSON.stringify(r))
    .join("\n")
    .concat("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is Rec => isRec(c) && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export function parseTranscript(compactJsonl: string): Transcript {
  const out: Transcript = {
    cwd: undefined,
    systemSections: undefined,
    toolCalls: [],
    finalText: "",
    finalLine: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cost: 0 },
    errors: [],
  };
  const byId = new Map<string, ToolCall>();
  records(compactJsonl).forEach((r, i) => {
    if (!isRec(r)) return;
    const line = i + 1;
    if (r.type === "session" && typeof r.cwd === "string") out.cwd = r.cwd;
    if (r.type === "tool_execution_start") {
      const call: ToolCall = {
        seq: out.toolCalls.length,
        line,
        id: String(r.toolCallId),
        name: String(r.toolName),
        args: isRec(r.args) ? r.args : {},
        resultText: "",
        isError: undefined,
      };
      out.toolCalls.push(call);
      byId.set(call.id, call);
    }
    if (r.type === "tool_execution_end") {
      const call = byId.get(String(r.toolCallId));
      if (call) {
        call.resultText = isRec(r.result) ? textOf(r.result.content) : "";
        call.isError = r.isError === true;
      }
    }
    if (r.type === "message_end" && isRec(r.message)) {
      const m = r.message;
      if (m.role === "system" && isRec(m.sections) && out.systemSections === undefined) {
        out.systemSections = Object.fromEntries(Object.entries(m.sections).map(([k, v]) => [k, String(v)]));
      }
      if (m.role === "assistant") {
        if (isRec(m.usage)) {
          const u = m.usage;
          out.usage.input += Number(u.input ?? 0);
          out.usage.output += Number(u.output ?? 0);
          out.usage.cacheRead += Number(u.cacheRead ?? 0);
          out.usage.cost += isRec(u.cost) ? Number(u.cost.total ?? 0) : 0;
        }
        if (m.stopReason === "error" || m.stopReason === "aborted") out.errors.push(String(m.errorMessage ?? m.stopReason));
        const text = textOf(m.content);
        if (text.trim()) {
          out.finalText = text;
          out.finalLine = line;
        }
      }
    }
  });
  return out;
}

// ---- classification -------------------------------------------------------------------

/** Normalize a tool path to a project-relative POSIX path, or undefined when it is outside. */
export function projectRelative(path: string, cwd: string): string | undefined {
  const strip = (p: string) => p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
  const base = strip(cwd);
  const p = path.startsWith("/") ? strip(path) : `${base}/${path.replace(/^\.\//, "")}`;
  if (!p.startsWith(`${base}/`)) return undefined;
  const parts: string[] = [];
  for (const seg of p.slice(base.length + 1).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export const isTestPath = (rel: string): boolean =>
  /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)test_[^/]*\.py$/.test(rel) || /_test\.py$/.test(rel);

export const isSourcePath = (rel: string): boolean => /\.(py|[cm]?[jt]sx?)$/.test(rel);

export const isProductionSource = (rel: string): boolean => isSourcePath(rel) && !isTestPath(rel);

const PATH_TOKEN = /[\w./-]+\.(?:py|[cm]?[jt]sx?|md|json|txt|csv)\b/g;
const IN_PLACE_WRITERS = /\bsed\s+(-\w*\s+)*-i|\bperl\s+-\w*i|\btee\b|write_text|\bopen\([^)]*["'][wa]["']|apply_patch|\bgit\s+(apply|checkout|restore)\b|(^|[\s;&|])patch\s|(^|[\s;&|])(mv|cp)\s/;

/**
 * Files a bash command may have written, relative to the project. This is a deliberate
 * over-approximation for in-place editors (any path-like token in such a command counts)
 * and exact for shell redirections. It cannot see writes made by scripts it does not read.
 */
export function bashWrites(command: string, cwd: string): string[] {
  const found = new Set<string>();
  for (const m of command.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s;&|<>()]+)/g)) {
    const target = m[1]!.replace(/^["']|["']$/g, "");
    if (target === "/dev/null" || target.startsWith("&")) continue;
    const rel = projectRelative(target, cwd);
    if (rel) found.add(rel);
  }
  if (IN_PLACE_WRITERS.test(command)) {
    for (const m of command.matchAll(PATH_TOKEN)) {
      const rel = projectRelative(m[0], cwd);
      if (rel) found.add(rel);
    }
  }
  return [...found];
}

/** Files a tool call wrote or may have written, relative to the project. */
export function writesOf(call: ToolCall, cwd: string): string[] {
  if (call.name === "edit" || call.name === "write") {
    const p = call.args.path ?? call.args.file_path;
    const rel = typeof p === "string" ? projectRelative(p, cwd) : undefined;
    return rel ? [rel] : [];
  }
  if (call.name === "bash" && typeof call.args.command === "string") return bashWrites(call.args.command, cwd);
  return [];
}

const TEST_RUNNER =
  /(^|[\s;&|(])(bun\s+(run\s+)?test|python3?\s+(-\w+\s+)*-m\s+(unittest|pytest)|pytest|npm\s+(run\s+)?test|npx\s+(vitest|jest)|python3?\s+\S*\btests?\/test_\S+\.py)\b/;

export type TestOutcome = "passed" | "failed" | "error";

/**
 * Outcome of a test-runner invocation, from the runner's own summary in the output.
 * "failed" needs a failing-test summary (bun "N fail", unittest "FAILED (", pytest "N failed"),
 * so a missing runner or a typo'd command is "error", never a reproduction.
 */
export function testRunOutcome(call: ToolCall): TestOutcome | undefined {
  if (call.name !== "bash" || typeof call.args.command !== "string" || !TEST_RUNNER.test(call.args.command)) return undefined;
  const out = call.resultText;
  if (/(^|\s)[1-9]\d* fail\b/m.test(out) || /FAILED \((failures|errors)=/.test(out) || /\b[1-9]\d* (failed|errors?)\b.*\bin [\d.]+s/.test(out)) {
    return "failed";
  }
  const sawPass = /(^|\s)0 fail\b/m.test(out) || /^OK\b/m.test(out) || /\b\d+ passed\b/.test(out);
  return sawPass && call.isError !== true ? "passed" : "error";
}

/** The first tool call that read the loaded skill's SKILL.md (by the read tool or a shell command). */
export function readSkill(t: Transcript): ToolCall | undefined {
  return t.toolCalls.find((c) => {
    const target = c.name === "read" ? String(c.args.path ?? "") : c.name === "bash" ? String(c.args.command ?? "") : "";
    return /\/\.agents\/skills\/[\w-]+\/SKILL\.md\b/.test(target);
  });
}
