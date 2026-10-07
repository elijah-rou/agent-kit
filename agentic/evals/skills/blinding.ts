// Deterministic blinding checker for skill runs (design D11; rules adapted from
// pstack poteto-mode/playbooks/eval.md, MIT, upstream commit 9f451cf).
//
// The rule, precisely:
//
// 1. Text is split into word tokens. A token is a maximal run of ASCII letters,
//    further split at camelCase and acronym boundaries ("runEvalJSON" becomes
//    "run", "eval", "json"). Digits, underscores, hyphens, dots, slashes, and all
//    other characters separate tokens. Tokens are compared lowercased and whole,
//    so "attest", "latest", and "contest" never match "test".
// 2. META_WORDS are banned in everything a candidate can see: the prompt, every
//    path segment, every fixture file's contents, fixture commit messages, the
//    skill text, environment values passed to the candidate, and the system
//    prompt Pi actually sent (read back from the transcript after the run).
//    "harness" is deliberately absent: Pi's stock preamble calls Pi "a coding
//    agent harness" in every ordinary session, so it reveals nothing.
// 3. HARNESS_WORDS ("test", "fixture", "scenario" and inflections) are banned
//    only in text the harness itself chooses: the prompt and the directory names
//    the harness creates (project directory, skill directory). They stay allowed
//    in fixture contents and fixture paths, because real projects have tests, and
//    in skill text, because the real skills discuss tests. Banning "test" from the
//    prompt also stops the prompt from cueing the behavior under measurement.
// 4. A harness-chosen project directory name must look like a name a person would
//    pick: lowercase kebab-case, one to four alphabetic words of two or more
//    letters, no placeholder word (PLACEHOLDER_WORDS), and no banned word.

const META_WORDS: readonly string[] = [
  "eval", "evals", "evaluate", "evaluates", "evaluated", "evaluating", "evaluation", "evaluations", "evaluator", "evaluators",
  "judge", "judges", "judged", "judging", "judgement", "judgements", "judgment", "judgments",
  "rubric", "rubrics",
  "score", "scores", "scored", "scoring", "scorer", "scorers", "scorecard", "scorecards",
  "benchmark", "benchmarks", "benchmarked", "benchmarking",
  "candidate", "candidates",
  "experiment", "experiments", "experimental", "experimenting", "experimented",
  "compare", "compares", "compared", "comparing", "comparison", "comparisons",
  "arena", "arenas",
  "weaken", "weakens", "weakened", "weakening",
  "variant", "variants",
  "grader", "graders", "grading",
  "blinded", "blinding",
  "sandbox", "sandboxes", "sandboxed",
];

const HARNESS_WORDS: readonly string[] = [
  "test", "tests", "tested", "testing", "tester", "testers",
  "fixture", "fixtures",
  "scenario", "scenarios",
];

const PLACEHOLDER_WORDS: readonly string[] = [
  "tmp", "temp", "foo", "bar", "baz", "qux", "demo", "sample", "example", "dummy", "fake", "mock",
  "project", "repo", "dir", "folder", "workspace", "run", "case", "task", "copy", "current", "new", "old",
  "subject", "probe", "trial", "check", "target",
];

const metaSet = new Set(META_WORDS);
const harnessSet = new Set(HARNESS_WORDS);
const placeholderSet = new Set(PLACEHOLDER_WORDS);

export type Tier = "visible" | "harness-chosen";

export type Finding = {
  where: string;
  word: string;
  context: string;
};

/** Split text into lowercased word tokens with their offsets; see rule 1. */
export function tokenize(text: string): { token: string; index: number }[] {
  const out: { token: string; index: number }[] = [];
  for (const run of text.matchAll(/[A-Za-z]+/g)) {
    const base = run.index ?? 0;
    for (const part of run[0].matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g)) {
      out.push({ token: part[0].toLowerCase(), index: base + (part.index ?? 0) });
    }
  }
  return out;
}

function bannedIn(tier: Tier): (token: string) => boolean {
  if (tier === "visible") return (t) => metaSet.has(t);
  return (t) => metaSet.has(t) || harnessSet.has(t);
}

/** Every banned word in `text` for the tier, with a short surrounding context. */
export function findBanned(text: string, tier: Tier, where: string): Finding[] {
  const banned = bannedIn(tier);
  return tokenize(text)
    .filter(({ token }) => banned(token))
    .map(({ token, index }) => ({
      where,
      word: token,
      context: text.slice(Math.max(0, index - 30), index + token.length + 30).replace(/\s+/g, " "),
    }));
}

/** Problems with a harness-chosen project directory name; empty when it passes rule 4. */
export function projectNameProblems(name: string): string[] {
  const problems: string[] = [];
  if (!/^[a-z]+(-[a-z]+){0,3}$/.test(name)) {
    problems.push(`"${name}" is not lowercase kebab-case of one to four alphabetic words`);
    return problems;
  }
  for (const word of name.split("-")) {
    if (word.length < 2) problems.push(`"${name}" has a one-letter word "${word}"`);
    if (placeholderSet.has(word)) problems.push(`"${name}" uses the placeholder word "${word}"`);
    if (metaSet.has(word) || harnessSet.has(word)) problems.push(`"${name}" uses the banned word "${word}"`);
  }
  return problems;
}

/** Everything a candidate can see before its run starts. */
export type CandidateView = {
  prompt: string;
  /** Absolute path of the project directory the candidate works in. */
  projectDir: string;
  /** Project directory name chosen by the harness (last segment of projectDir). */
  projectName: string;
  /** Path segments the harness chose for the skill location, e.g. [".agents", "skills", "verification"]. */
  skillSegments: string[];
  /** Absolute path of SKILL.md as Pi will advertise it. */
  skillPath: string;
  skillText: string;
  files: { path: string; content: string }[];
  commitMessages: string[];
  env: Record<string, string>;
  /**
   * The subject's own guidance shown verbatim: the skill text, and for planning the AGENTS.md
   * excerpt of the live instructions. Meta words these real texts contain (design-checkpoint
   * says "compare ... candidates") are exempt where that text is shown, and nowhere else.
   * Weakened copies are real texts too (the current skill with rules deleted, or a version from
   * before the port), so no harness-written word is exempt.
   */
  subjectTexts?: string[];
};

/** Meta words that occur in the subject's real guidance texts. */
export function subjectExemptions(texts: readonly string[]): Set<string> {
  return new Set(texts.flatMap((text) => tokenize(text).map(({ token }) => token)).filter((token) => metaSet.has(token)));
}

const exempting = (findings: Finding[], exempt: Set<string>) => findings.filter((finding) => !exempt.has(finding.word));

/** Audit a candidate view against rules 2 to 4. An empty result means the view is blinded. */
export function auditView(view: CandidateView): Finding[] {
  const findings: Finding[] = [
    ...findBanned(view.prompt, "harness-chosen", "prompt"),
    ...findBanned(view.projectDir, "visible", "project path"),
    ...findBanned(view.skillPath, "visible", "skill path"),
    ...exempting(findBanned(view.skillText, "visible", "skill text"), subjectExemptions(view.subjectTexts ?? [])),
    ...view.skillSegments.flatMap((s) => findBanned(s, "harness-chosen", `skill path segment ${s}`)),
    ...findBanned(view.projectName, "harness-chosen", "project name"),
    ...projectNameProblems(view.projectName).map((p) => ({ where: "project name", word: view.projectName, context: p })),
  ];
  const exempt = subjectExemptions(view.subjectTexts ?? []);
  for (const file of view.files) {
    findings.push(...findBanned(file.path, "visible", `file path ${file.path}`));
    const content = findBanned(file.content, "visible", `file ${file.path}`);
    findings.push(...((view.subjectTexts ?? []).includes(file.content) ? exempting(content, exempt) : content));
  }
  for (const message of view.commitMessages) findings.push(...findBanned(message, "visible", "commit message"));
  for (const [key, value] of Object.entries(view.env)) {
    findings.push(...findBanned(key, "visible", `env name ${key}`));
    findings.push(...findBanned(value, "visible", `env ${key}`));
  }
  return findings;
}

/** Audit the system prompt sections Pi actually sent, read back from the JSON transcript. */
export function auditSystemSections(sections: Record<string, string>, exempt: Set<string> = new Set()): Finding[] {
  return Object.entries(sections).flatMap(([name, text]) => exempting(findBanned(text, "visible", `system prompt section ${name}`), exempt));
}
