import { describe, expect, test } from "bun:test";
import { auditSystemSections, auditView, type CandidateView, findBanned, projectNameProblems, tokenize } from "./blinding.ts";

const words = (text: string) => tokenize(text).map((t) => t.token);

describe("tokenize", () => {
  test("splits camelCase, acronyms, digits, and punctuation", () => {
    expect(words("runEvalJSON2go")).toEqual(["run", "eval", "json", "go"]);
    expect(words("HTTPServer snake_case kebab-case a/b.c")).toEqual(["http", "server", "snake", "case", "kebab", "case", "a", "b", "c"]);
  });
});

describe("findBanned", () => {
  test("matches whole words only", () => {
    for (const ok of ["attest", "latest", "contest", "medieval", "prejudged", "underscored", "comparative"]) {
      expect(findBanned(ok, "harness-chosen", "x")).toEqual([]);
    }
  });

  test("catches meta words in any case and inside identifiers", () => {
    const hits = (s: string) => findBanned(s, "visible", "x").map((f) => f.word);
    expect(hits("Run the EVAL now")).toEqual(["eval"]);
    expect(hits("const judgeScore = 1")).toEqual(["judge", "score"]);
    expect(hits("re-evaluate the weakened_variant")).toEqual(["evaluate", "weakened", "variant"]);
    expect(hits("an arena of candidates; compare the rubric")).toEqual(["arena", "candidates", "compare", "rubric"]);
    expect(hits("benchmark experiments")).toEqual(["benchmark", "experiments"]);
  });

  test("allows test vocabulary in visible text but not in harness-chosen text", () => {
    expect(findBanned("tests/test_split.py runs the tests", "visible", "x")).toEqual([]);
    expect(findBanned("add a failing test first", "harness-chosen", "prompt").map((f) => f.word)).toEqual(["test"]);
    expect(findBanned("the scenario fixture", "harness-chosen", "prompt").map((f) => f.word)).toEqual(["scenario", "fixture"]);
  });

  test("reports location and context", () => {
    const [f] = findBanned("please do not eval this", "visible", "prompt");
    expect(f?.where).toBe("prompt");
    expect(f?.context).toContain("not eval this");
  });
});

describe("projectNameProblems", () => {
  test("accepts names a person would pick", () => {
    for (const name of ["pantry", "tab-splitter", "ride-journal", "pocket-ledger", "pantry-tracker"]) {
      expect(projectNameProblems(name)).toEqual([]);
    }
  });

  test("rejects placeholders, meta words, random suffixes, and bad shapes", () => {
    for (const name of ["test-app", "eval-one", "demo", "run-a", "proj1", "Pantry", "skill_x", "work-Id7xhF", "a-b-c-d-e", "weakened-copy"]) {
      expect(projectNameProblems(name).length).toBeGreaterThan(0);
    }
  });
});

const cleanView = (): CandidateView => ({
  prompt: "My weekly summary shows 1h 60m for a ride. Can you sort that out?",
  projectDir: "/private/var/folders/xy/T/tmp.Ab12Cd/ride-journal",
  projectName: "ride-journal",
  skillSegments: [".agents", "skills", "verification"],
  skillPath: "/var/folders/xy/T/tmp.Ab12Cd/.agents/skills/verification/SKILL.md",
  skillText: "Add one durable case and run the tests.",
  files: [{ path: "test/duration.test.ts", content: 'import { test } from "bun:test";' }],
  commitMessages: ["Initial version"],
  env: { HOME: "/var/folders/xy/T/tmp.Ab12Cd", PATH: "/usr/bin:/bin" },
});

describe("auditView", () => {
  test("passes a clean view", () => {
    expect(auditView(cleanView())).toEqual([]);
  });

  test("flags each leak by location", () => {
    const where = (patch: Partial<CandidateView>) => auditView({ ...cleanView(), ...patch }).map((f) => f.where);
    expect(where({ projectDir: "/var/tmp/prototype-wt/evals/.sandbox/ride-journal" })).toContain("project path");
    expect(where({ skillPath: "/x/subjects/verification/weakened/SKILL.md" })).toContain("skill path");
    expect(where({ prompt: "Write a test first, then fix it" })).toContain("prompt");
    expect(where({ projectName: "tmp-project" })).toContain("project name");
    expect(where({ files: [{ path: "src/score.ts", content: "" }] })).toContain("file path src/score.ts");
    expect(where({ commitMessages: ["Set up the benchmark"] })).toContain("commit message");
    expect(where({ env: { RUN_KIND: "candidate" } })).toContain("env RUN_KIND");
    expect(where({ skillSegments: [".agents", "skills", "variant-b"] })).toContain("skill path segment variant-b");
  });
});

describe("auditSystemSections", () => {
  test("flags a leaked word in any section", () => {
    expect(auditSystemSections({ cwd: "/tmp/ride-journal", skills: "<location>/x/eval/SKILL.md</location>" }).map((f) => f.where)).toEqual([
      "system prompt section skills",
    ]);
  });
});
