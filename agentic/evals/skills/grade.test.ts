import { describe, expect, test } from "bun:test";
import {
  acceptance,
  bodyLines,
  buildJudgePrompt,
  type CommitFact,
  gradeGit,
  gradeVerification,
  parseVerdicts,
  type RepoFacts,
  runScore,
  verificationMaterial,
} from "./grade.ts";
import { scenarioById } from "./scenarios.ts";
import { bashWrites, compact, parseTranscript, projectRelative, readSkill, testRunOutcome, type ToolCall } from "./transcript.ts";

const CWD = "/private/var/folders/xy/T/tmp.Ab12Cd/tab-splitter";

type Step = { tool: string; args: Record<string, unknown>; out?: string; error?: boolean };

/** Build a raw Pi JSON stream: session header, system message, tool calls, final reply. */
function stream(steps: Step[], reply = "Fixed it."): string {
  const recs: unknown[] = [
    { type: "session", version: 3, id: "s", cwd: CWD },
    { type: "message_end", message: { role: "system", sections: { cwd: CWD } } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
  ];
  steps.forEach((s, i) => {
    recs.push({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: s.tool, args: s.args });
    recs.push({ type: "tool_execution_update", toolCallId: `c${i}`, toolName: s.tool });
    recs.push({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: s.tool, result: { content: [{ type: "text", text: s.out ?? "" }] }, isError: s.error ?? false });
  });
  recs.push({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: reply }], usage: { input: 10, output: 5, cacheRead: 1, cost: { total: 0.5 } } },
  });
  return recs.map((r) => JSON.stringify(r)).join("\n");
}

const UNITTEST_FAIL = "F...\nFAIL: test_three_way\n----\nRan 4 tests in 0.001s\n\nFAILED (failures=1)\nCommand exited with code 1";
const UNITTEST_OK = "....\n----\nRan 4 tests in 0.001s\n\nOK";
const readSkillStep: Step = { tool: "read", args: { path: "/var/folders/xy/T/tmp.Ab12Cd/.agents/skills/verification/SKILL.md" } };
const addCase: Step = { tool: "edit", args: { path: "tests/test_split.py" } };
const runSuiteFail: Step = { tool: "bash", args: { command: "python3 -m unittest" }, out: UNITTEST_FAIL, error: true };
const fixSource: Step = { tool: "edit", args: { path: `${CWD}/tabsplit/split.py` } };
const runSuiteOk: Step = { tool: "bash", args: { command: "python3 -m unittest -v" }, out: UNITTEST_OK };

const goodFacts: RepoFacts = {
  initialSha: "abc",
  commits: [],
  statusPorcelain: " M tabsplit/split.py\n M tests/test_split.py\n",
  changedFiles: ["tabsplit/split.py", "tests/test_split.py"],
  holdout: { exitCode: 0, output: "ok" },
  suiteFinal: { exitCode: 0, output: "OK" },
  suiteReverted: { exitCode: 1, output: "FAILED (failures=1)" },
};
const refs = { transcript: "transcripts/r.jsonl", facts: "facts/r.json", judge: "judge/split-cents.jsonl" };

describe("transcript parsing", () => {
  test("compaction drops streaming deltas and keeps order and results", () => {
    const t = parseTranscript(compact(stream([readSkillStep, runSuiteFail])));
    expect(t.cwd).toBe(CWD);
    expect(t.systemSections).toEqual({ cwd: CWD });
    expect(t.toolCalls.map((c) => [c.seq, c.name, c.isError])).toEqual([
      [0, "read", false],
      [1, "bash", true],
    ]);
    expect(t.toolCalls[1]?.line).toBe(5);
    expect(t.finalText).toBe("Fixed it.");
    expect(t.usage).toEqual({ input: 10, output: 5, cacheRead: 1, cost: 0.5 });
    expect(readSkill(t)?.seq).toBe(0);
  });

  test("paths normalize across /private and relative forms", () => {
    expect(projectRelative("/var/folders/xy/T/tmp.Ab12Cd/tab-splitter/tabsplit/split.py", CWD)).toBe("tabsplit/split.py");
    expect(projectRelative("./tests/../tabsplit/split.py", CWD)).toBe("tabsplit/split.py");
    expect(projectRelative("/etc/hosts", CWD)).toBeUndefined();
  });

  test("bash writes: exact redirections, in-place editors, and plain reads", () => {
    expect(bashWrites("cat > tabsplit/split.py <<'EOF'\nx\nEOF", CWD)).toEqual(["tabsplit/split.py"]);
    expect(bashWrites("python3 -m unittest 2>&1 >/dev/null", CWD)).toEqual([]);
    expect(bashWrites("sed -i '' 's/a/b/' tabsplit/split.py", CWD)).toEqual(["tabsplit/split.py"]);
    expect(bashWrites("cat tabsplit/split.py && python3 -m unittest", CWD)).toEqual([]);
    expect(bashWrites("python3 - <<'EOF'\nopen('tabsplit/split.py', 'w').write(s)\nEOF", CWD)).toEqual(["tabsplit/split.py"]);
  });

  test("test-run outcomes come from runner summaries, not exit codes alone", () => {
    const call = (command: string, resultText: string, isError: boolean): ToolCall => ({ seq: 0, line: 1, id: "c", name: "bash", args: { command }, resultText, isError });
    expect(testRunOutcome(call("python3 -m unittest", UNITTEST_FAIL, true))).toBe("failed");
    expect(testRunOutcome(call("python3 -m unittest 2>&1 | tail -3", "FAILED (errors=1)", false))).toBe("failed");
    expect(testRunOutcome(call("python3 -m unittest", UNITTEST_OK, false))).toBe("passed");
    expect(testRunOutcome(call("bun test", " 3 pass\n 1 fail\nRan 4 tests", true))).toBe("failed");
    expect(testRunOutcome(call("bun test test/duration.test.ts", " 4 pass\n 0 fail\nRan 4 tests", false))).toBe("passed");
    expect(testRunOutcome(call("pytest", "zsh: command not found: pytest", true))).toBe("error");
    expect(testRunOutcome(call("python3 -m tabsplit 100 3", "Person 1: $33.33", false))).toBeUndefined();
  });
});

describe("gradeVerification", () => {
  const scenario = scenarioById("split-cents");
  const grade = (steps: Step[], facts = goodFacts) =>
    Object.fromEntries(gradeVerification(scenario, parseTranscript(compact(stream(steps))), facts, { pass: true, reason: "ok" }, refs).map((r) => [r.id, r]));

  test("RED, fix, GREEN passes every deterministic criterion with line evidence", () => {
    const r = grade([readSkillStep, addCase, runSuiteFail, fixSource, runSuiteOk]);
    expect(r.red_before_fix?.pass).toBe(true);
    expect(r.red_before_fix?.evidence).toEqual(["transcripts/r.jsonl#L7", "transcripts/r.jsonl#L9"]);
    expect(r.durable_regression_case?.pass).toBe(true);
    expect(r.green_after_last_fix?.pass).toBe(true);
    expect(r.fix_correct?.pass).toBe(true);
    expect(r.report_faithful?.pass).toBe(true);
  });

  test("fixing first and adding coverage afterwards is not RED before the fix", () => {
    const r = grade([fixSource, addCase, runSuiteOk]);
    expect(r.red_before_fix?.pass).toBe(false);
    expect(r.green_after_last_fix?.pass).toBe(true);
  });

  test("a failing run only after the fix does not count, and no run after the last edit fails GREEN", () => {
    const r = grade([fixSource, runSuiteFail, { tool: "write", args: { path: "tabsplit/split.py" } }]);
    expect(r.red_before_fix?.pass).toBe(false);
    expect(r.green_after_last_fix?.pass).toBe(false);
  });

  test("a missing runner is not a reproduction", () => {
    const r = grade([{ tool: "bash", args: { command: "pytest" }, out: "command not found: pytest", error: true }, fixSource, runSuiteOk]);
    expect(r.red_before_fix?.pass).toBe(false);
  });

  test("durable case needs a test change that fails without the production fix", () => {
    const steps = [addCase, runSuiteFail, fixSource, runSuiteOk];
    expect(grade(steps, { ...goodFacts, changedFiles: ["tabsplit/split.py"] }).durable_regression_case?.pass).toBe(false);
    expect(grade(steps, { ...goodFacts, suiteReverted: { exitCode: 0, output: "OK" } }).durable_regression_case?.pass).toBe(false);
    expect(grade(steps, { ...goodFacts, holdout: { exitCode: 1, output: "uneven" } }).fix_correct?.pass).toBe(false);
  });

  test("a missing judge verdict counts as not met", () => {
    const results = gradeVerification(scenario, parseTranscript(compact(stream([]))), goodFacts, undefined, refs);
    expect(results.find((r) => r.id === "report_faithful")?.pass).toBe(false);
  });
});

describe("gradeGit", () => {
  const scenario = scenarioById("ledger-two-changes");
  const commit = (subject: string, body: string, files: string[]): CommitFact => ({ sha: subject, subject, body, files, parents: 1 });
  const facts = (commits: CommitFact[], patch: Partial<RepoFacts> = {}): RepoFacts => ({
    initialSha: "abc",
    commits,
    statusPorcelain: "",
    changedFiles: [],
    holdout: { exitCode: 0, output: "ok" },
    ...patch,
  });
  const grade = (f: RepoFacts) => Object.fromEntries(gradeGit(scenario, f, { pass: true, reason: "explains why" }, refs).map((r) => [r.id, r.pass]));

  const money = commit("Show negative amounts as -$12.50", "The report read $-12.50, which is hard to scan.", ["src/money.ts", "test/money.test.ts"]);
  const flag = commit("Accept --output for the report file", "--out stays as an alias for existing scripts.", ["src/args.ts", "README.md", "test/args.test.ts"]);

  test("two focused commits with bodies pass", () => {
    expect(grade(facts([money, flag]))).toEqual({
      one_concern_per_commit: true,
      commit_bodies_present: true,
      bodies_explain_why: true,
      short_subjects: true,
      complete_and_clean: true,
    });
  });

  test("one mixed commit without a body fails the targeted criteria", () => {
    const r = grade(facts([commit("Fix formatting and add --output", "", ["src/money.ts", "src/args.ts", "README.md"])]));
    expect(r.one_concern_per_commit).toBe(false);
    expect(r.commit_bodies_present).toBe(false);
    expect(r.short_subjects).toBe(true);
  });

  test("trailers alone are not a body; neutral files do not mix concerns", () => {
    expect(bodyLines("\nCo-authored-by: A <a@example.com>\n")).toEqual([]);
    const withNeutral = commit("Bump version", "Release the two fixes.", ["package.json"]);
    expect(grade(facts([money, flag, withNeutral])).one_concern_per_commit).toBe(true);
  });

  test("an uncovered concern, no commits, dirty tree, and long subjects all fail", () => {
    expect(grade(facts([money, money])).one_concern_per_commit).toBe(false);
    const none = grade(facts([]));
    expect(Object.values(none).slice(0, 4)).toEqual([false, false, false, false]);
    expect(grade(facts([money, flag], { statusPorcelain: "?? notes.txt\n" })).complete_and_clean).toBe(false);
    expect(grade(facts([commit("x".repeat(73), "why", ["src/money.ts"]), flag])).short_subjects).toBe(false);
  });
});

describe("scores and acceptance", () => {
  test("run score is the fraction of criteria met", () => {
    const r = gradeGit(scenarioById("pantry-two-changes"), { initialSha: "a", commits: [], statusPorcelain: "", changedFiles: [], holdout: { exitCode: 1, output: "TypeError" } }, undefined, refs);
    expect(runScore(r)).toBe(0);
  });

  test("acceptance needs current high, weakened low, and the margin", () => {
    expect(acceptance([1, 0.8, 0.8, 1], [0.6, 0.4, 0.6, 0.6]).accepted).toBe(true);
    expect(acceptance([0.8, 0.8], [0.6, 0.6]).accepted).toBe(true);
    expect(acceptance([0.8, 0.8], [0.7, 0.7]).accepted).toBe(false);
    expect(acceptance([0.6, 0.6], [0.2, 0.2]).accepted).toBe(false);
    expect(acceptance([1, 1], [0.6, 0.6]).accepted).toBe(true);
    expect(() => acceptance([], [1])).toThrow();
  });
});

describe("judge prompt", () => {
  const criterion = scenarioById("ledger-two-changes").rubric.find((c) => c.id === "bodies_explain_why")!;

  test("labels only, criterion verbatim, and a strict reply shape", () => {
    const prompt = buildJudgePrompt("Two things...", criterion, [
      { label: "A", material: "Commit 1" },
      { label: "B", material: "Commit 2" },
    ]);
    expect(prompt).toContain(criterion.text);
    expect(prompt).toContain("=== Output A ===");
    expect(prompt).toContain("labels: A, B");
  });

  test("material that names the skill copy is refused", () => {
    expect(() => buildJudgePrompt("r", criterion, [{ label: "A", material: "see subjects/x/weakened/SKILL.md" }])).toThrow();
  });

  test("verdict parsing tolerates prose around JSON and rejects missing labels", () => {
    const v = parseVerdicts('Here:\n{"verdicts":[{"label":"A","pass":true,"reason":"r"},{"label":"B","pass":false,"reason":"s"}]}', ["A", "B"]);
    expect(v.get("B")).toEqual({ pass: false, reason: "s" });
    expect(() => parseVerdicts('{"verdicts":[{"label":"A","pass":true}]}', ["A", "B"])).toThrow("lacks labels B");
    expect(() => parseVerdicts("no json", ["A"])).toThrow();
  });

  test("verification material shows commands and outcomes but never file contents read", () => {
    const t = parseTranscript(compact(stream([{ ...readSkillStep, out: "SECRET SKILL TEXT" }, runSuiteFail], "All good")));
    const m = verificationMaterial(t);
    expect(m).toContain("#1 read /var/folders/xy/T/tmp.Ab12Cd/.agents/skills/verification/SKILL.md");
    expect(m).toContain("#2 bash: python3 -m unittest");
    expect(m).toContain("FAILED (failures=1)");
    expect(m).not.toContain("SECRET SKILL TEXT");
  });
});
