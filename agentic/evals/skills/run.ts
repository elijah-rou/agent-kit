// Blinded skill runner (design D11).
//
//   bun agentic/evals/skills/run.ts plan                      # build and audit every candidate view; no model calls
//   bun agentic/evals/skills/run.ts candidates [--only <id>]  # candidate runs, N=REPS per scenario and skill copy
//   bun agentic/evals/skills/run.ts judge                     # one blinded judge pass per scenario
//   bun agentic/evals/skills/run.ts grade                     # writes results.jsonl and prints the summary
//
// The current copy of each subject is the live skill in this repository (skills/<name>/SKILL.md;
// for planning, the planning bullets of claude/CLAUDE.md plus design-checkpoint); the weakened
// copy lives in subjects/<name>/weakened/. Candidates work in a fresh mktemp-style directory
// under the OS temp dir: Pi shows the model its cwd and each skill's path, and this repository's
// path contains "evals". HOME is that directory, the skill sits at $HOME/.agents/skills/<name>,
// and the environment is an allowlist. Raw output goes to a scratch directory under the OS temp
// dir; compacted transcripts and repository facts are kept under runs/ so evidence pointers
// survive. The judge is a different model family from the candidates (Claude via its CLI).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { auditSystemSections, auditView, type CandidateView, type Finding, subjectExemptions } from "./blinding.ts";
import {
  acceptance,
  buildJudgePrompt,
  type CommandResult,
  type CommitFact,
  type CriterionResult,
  gitMaterial,
  gradeGit,
  gradePlanning,
  gradeVerification,
  parseVerdicts,
  type RepoFacts,
  runScore,
  type Verdict,
  verificationMaterial,
} from "./grade.ts";
import { projectFixture, promptFor, SCENARIOS, type Scenario, type Subject, type Variant, VARIANTS } from "./scenarios.ts";
import { compact, isProductionSource, parseTranscript, readSkill } from "./transcript.ts";

export const CANDIDATE_THINKING = "medium";
/** A different family from the OpenAI candidates, as design D11 requires. */
export const JUDGE_MODEL = "sonnet";
export const JUDGE_THINKING = "high";
export const REPS = 2;
const CANDIDATE_LAUNCH_BUDGET = 40;
const JUDGE_LAUNCH_BUDGET = 16;
const CONCURRENCY = 4;
const RUN_TIMEOUT_MS = 20 * 60_000;
/**
 * Pi's CLI entry, run with the current Bun. The bootstrap `pi` wrapper derives its paths from
 * $HOME, which candidates get as their sanitized directory, so the wrapper cannot be used.
 */
const PI_CLI = join(process.env.BUN_INSTALL ?? "", "install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const CHECK_TIMEOUT_MS = 120_000;

const HERE = import.meta.dir;
const WORKTREE = resolve(HERE, "../../..");
const SCRATCH = join(tmpdir(), "agent-kit-skill-runs");
const RUNS = join(HERE, "runs");
const RESULTS = join(HERE, "results.jsonl");
const LAUNCHES = join(SCRATCH, "launches.jsonl");
const rel = (p: string) => relative(WORKTREE, p);

const GIT_IDENTITY = "[user]\n\tname = Sam Okafor\n\temail = sam.okafor@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n";
const INITIAL_DATE = "2026-09-28T19:42:00+01:00";

type RunKey = { scenario: Scenario; variant: Variant; rep: number; id: string };
type RunStatus = "ok" | "timeout" | "infra-error" | "blinding-violation";
type RunMeta = {
  id: string;
  scenario: string;
  subject: Subject;
  variant: Variant;
  rep: number;
  model: string;
  thinking: string;
  status: RunStatus;
  exitCode: number | null;
  durationS: number;
  initialSha: string;
  candidateCwd: string;
  preBlinding: Finding[];
  postBlinding: Finding[];
  skillsAdvertised: number;
  skillReadLine: number | null;
  toolCalls: number;
  usage: { input: number; output: number; cacheRead: number; cost: number };
  errors: string[];
};

const plan = (only?: string): RunKey[] =>
  SCENARIOS.filter((s) => !only || s.id === only).flatMap((scenario) =>
    VARIANTS.flatMap((variant) => Array.from({ length: REPS }, (_, i) => ({ scenario, variant, rep: i + 1, id: `${scenario.id}.${variant}.${i + 1}` }))),
  );

// ---- process helpers ----------------------------------------------------------------------

function sh(argv: string[], cwd: string, env: Record<string, string> = cleanGitEnv()): CommandResult {
  const r = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS });
  return { exitCode: r.exitCode ?? -1, output: `${r.stdout.toString()}${r.stderr.toString()}` };
}

function must(argv: string[], cwd: string, env?: Record<string, string>): string {
  const r = sh(argv, cwd, env);
  if (r.exitCode !== 0) throw new Error(`${argv.join(" ")} failed in ${cwd}: ${r.output}`);
  return r.output;
}

/** Environment for grader-side git and checks: no user git config, no inherited secrets. */
function cleanGitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    LANG: "en_US.UTF-8",
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
  };
}

function candidateEnv(root: string): Record<string, string> {
  const pass = ["PATH", "USER", "LOGNAME", "PI_CODING_AGENT_DIR", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"];
  const env: Record<string, string> = {};
  for (const k of pass) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (!env.PI_CODING_AGENT_DIR) throw new Error("PI_CODING_AGENT_DIR is not set; Pi would not find its credentials");
  return {
    ...env,
    HOME: root,
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

function walk(dir: string, base = dir): { path: string; content: string }[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".git") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [{ path: relative(base, full), content: readFileSync(full, "utf8") }];
  });
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

function launches(kind: "candidate" | "judge"): number {
  if (!existsSync(LAUNCHES)) return 0;
  return readFileSync(LAUNCHES, "utf8").split("\n").filter((l) => l.includes(`"kind":"${kind}"`)).length;
}

function recordLaunch(kind: "candidate" | "judge", id: string): void {
  const budget = kind === "candidate" ? CANDIDATE_LAUNCH_BUDGET : JUDGE_LAUNCH_BUDGET;
  if (launches(kind) >= budget) throw new Error(`${kind} launch budget of ${budget} is spent`);
  writeFileSync(LAUNCHES, `${JSON.stringify({ kind, id, at: new Date().toISOString() })}\n`, { flag: "a" });
}

async function runPi(args: string[], cwd: string, env: Record<string, string>, outPath: string, errPath: string) {
  const started = Date.now();
  if (!existsSync(PI_CLI)) throw new Error(`Pi CLI not found at ${PI_CLI}`);
  const proc = Bun.spawn([process.execPath, PI_CLI, ...args], { cwd, env, stdin: "ignore", stdout: Bun.file(outPath), stderr: Bun.file(errPath) });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, RUN_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, timedOut, durationS: Math.round((Date.now() - started) / 1000) };
}

// ---- subject materials --------------------------------------------------------------------

/** The guidance a candidate gets: one skill, plus an AGENTS.md excerpt for the planning subject. */
export type SubjectMaterial = { skillText: string; skillName: string; contextText?: string };

function frontmatterName(text: string): string {
  const name = /^---\n[\s\S]*?^name:\s*(\S+)/m.exec(text)?.[1];
  if (!name) throw new Error("subject skill has no frontmatter name");
  return name;
}

/** The planning bullets of the live instructions, as an AGENTS.md a project could carry. */
function planningInstructions(): string {
  const text = readFileSync(join(WORKTREE, "claude", "CLAUDE.md"), "utf8");
  const bullets = text.split("\n").filter((line) => line.startsWith("- Scale planning") || line.startsWith("- Do not ask for plan approval"));
  if (bullets.length !== 2) throw new Error("planning bullets not found in claude/CLAUDE.md");
  return `# Working guidelines\n\n${bullets.join("\n")}\n`;
}

export function subjectMaterial(subject: Subject, variant: Variant): SubjectMaterial {
  if (variant === "weakened") {
    const dir = join(HERE, "subjects", subject, "weakened");
    const skillText = readFileSync(join(dir, "SKILL.md"), "utf8");
    const contextPath = join(dir, "AGENTS.md");
    return { skillText, skillName: frontmatterName(skillText), contextText: existsSync(contextPath) ? readFileSync(contextPath, "utf8") : undefined };
  }
  const skillText = readFileSync(join(WORKTREE, "skills", subject === "planning" ? "design-checkpoint" : subject, "SKILL.md"), "utf8");
  return { skillText, skillName: frontmatterName(skillText), contextText: subject === "planning" ? planningInstructions() : undefined };
}

// ---- candidate setup ----------------------------------------------------------------------

type Prepared = { root: string; projectDir: string; skillDir: string; env: Record<string, string>; initialSha: string; view: CandidateView };

function prepare(key: RunKey): Prepared {
  const root = mkdtempSync(join(tmpdir(), "tmp."));
  const env = candidateEnv(root);
  writeFileSync(join(root, ".gitconfig"), GIT_IDENTITY);
  const material = subjectMaterial(key.scenario.subject, key.variant);
  const skillSegments = [".agents", "skills", material.skillName];
  const skillDir = join(root, ...skillSegments);
  mkdirSync(skillDir, { recursive: true });
  const skillText = material.skillText;
  writeFileSync(join(skillDir, "SKILL.md"), skillText);

  const projectDir = join(root, key.scenario.projectName);
  cpSync(projectFixture(key.scenario.id), projectDir, { recursive: true, filter: (src) => !/(__pycache__|node_modules)$/.test(src) });
  if (material.contextText !== undefined) writeFileSync(join(projectDir, "AGENTS.md"), material.contextText);
  const gitEnv = { ...env, GIT_AUTHOR_DATE: INITIAL_DATE, GIT_COMMITTER_DATE: INITIAL_DATE };
  must(["git", "init", "-q", "-b", "main"], projectDir, gitEnv);
  must(["git", "add", "-A"], projectDir, gitEnv);
  must(["git", "commit", "-q", "-m", key.scenario.initialCommit], projectDir, gitEnv);
  const initialSha = must(["git", "rev-parse", "HEAD"], projectDir, gitEnv).trim();

  const view: CandidateView = {
    prompt: promptFor(key.scenario.id),
    projectDir,
    projectName: key.scenario.projectName,
    skillSegments,
    skillPath: join(skillDir, "SKILL.md"),
    skillText,
    subjectTexts: [material.skillText, ...(material.contextText !== undefined ? [material.contextText] : [])],
    files: walk(projectDir),
    commitMessages: [key.scenario.initialCommit],
    env,
  };
  return { root, projectDir, skillDir, env, initialSha, view };
}

function removeRoot(root: string): void {
  const tmp = tmpdir().replace(/\/+$/, "");
  if (!root.startsWith(`${tmp}/tmp.`) || root.includes("..")) throw new Error(`refusing to remove unexpected path ${root}`);
  rmSync(root, { recursive: true, force: true });
}

// ---- facts --------------------------------------------------------------------------------

function holdoutArgv(s: Scenario, dir: string): string[] {
  return s.holdout.map((a) => (a === "{dir}" ? dir : a));
}

function collectFacts(s: Scenario, finalDir: string, initialSha: string, work: string): RepoFacts {
  const git = (...a: string[]) => must(["git", "--no-pager", ...a], finalDir);
  const shas = git("rev-list", "--reverse", `${initialSha}..HEAD`).split("\n").filter(Boolean);
  const commits: CommitFact[] = shas.map((sha) => {
    const [subject = "", body = "", parents = ""] = git("show", "-s", "--format=%s%x00%b%x00%P", sha).split("\0");
    const files = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).split("\n").filter(Boolean);
    return { sha, subject, body: body.trim(), files, parents: parents.trim().split(/\s+/).filter(Boolean).length };
  });
  const statusPorcelain = git("status", "--porcelain", "--untracked-files=all");
  const changed = new Set([
    ...git("diff", "--name-only", initialSha).split("\n").filter(Boolean),
    ...git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
  ]);
  const changedFiles = [...changed].sort();

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  if (s.subject === "git-workflow") {
    const head = join(work, "head");
    must(["git", "clone", "-q", finalDir, head], work);
    return { initialSha, commits, statusPorcelain, changedFiles, holdout: sh(holdoutArgv(s, head), head) };
  }
  const finalCopy = join(work, "final");
  cpSync(finalDir, finalCopy, { recursive: true });
  const holdout = sh(holdoutArgv(s, finalCopy), finalCopy);
  const suiteFinal = sh(s.testCommand, finalCopy);
  const reverted = join(work, "reverted");
  cpSync(finalDir, reverted, { recursive: true });
  for (const f of changedFiles.filter(isProductionSource)) {
    const existed = sh(["git", "cat-file", "-e", `${initialSha}:${f}`], reverted).exitCode === 0;
    if (existed) must(["git", "checkout", initialSha, "--", f], reverted);
    else rmSync(join(reverted, f), { force: true });
  }
  const suiteReverted = sh(s.testCommand, reverted);
  return { initialSha, commits, statusPorcelain, changedFiles, holdout, suiteFinal, suiteReverted };
}

// ---- commands -----------------------------------------------------------------------------

function cmdPlan(only?: string): void {
  let bad = 0;
  for (const key of plan(only)) {
    const p = prepare(key);
    try {
      const findings = auditView(p.view);
      bad += findings.length;
      console.log(`${key.id}: ${findings.length ? JSON.stringify(findings) : "blinded"} (${p.projectDir})`);
    } finally {
      removeRoot(p.root);
    }
  }
  if (bad) throw new Error(`${bad} blinding findings`);
}

async function runCandidate(key: RunKey): Promise<void> {
  const scratch = join(SCRATCH, key.id);
  const keep = join(RUNS, key.id);
  const metaPath = join(keep, "meta.json");
  if (existsSync(metaPath)) {
    const prior = JSON.parse(readFileSync(metaPath, "utf8")) as RunMeta;
    if (prior.status !== "infra-error") return console.log(`${key.id}: kept (${prior.status})`);
  }
  mkdirSync(scratch, { recursive: true });
  mkdirSync(keep, { recursive: true });
  const p = prepare(key);
  try {
    const preBlinding = auditView(p.view);
    if (preBlinding.length) throw new Error(`${key.id} is not blinded: ${JSON.stringify(preBlinding)}`);
    recordLaunch("candidate", key.id);
    console.log(`${key.id}: started in ${p.projectDir}`);
    const raw = join(scratch, "raw.jsonl");
    const args = [
      "--mode", "json",
      "--no-extensions", ...(key.scenario.subject === "planning" ? [] : ["--no-context-files"]), "--no-skills", "--no-prompt-templates", "--no-themes",
      "--skill", p.skillDir,
      "--no-session",
      "--model", key.scenario.model,
      "--thinking", CANDIDATE_THINKING,
      p.view.prompt,
    ];
    const r = await runPi(args, p.projectDir, p.env, raw, join(scratch, "stderr.log"));

    const compacted = compact(readFileSync(raw, "utf8"));
    writeFileSync(join(keep, "transcript.jsonl"), compacted);
    const t = parseTranscript(compacted);
    const postBlinding = auditSystemSections(t.systemSections ?? {}, subjectExemptions(p.view.subjectTexts ?? []));
    const finalDir = join(scratch, "final");
    rmSync(finalDir, { recursive: true, force: true });
    cpSync(p.projectDir, finalDir, { recursive: true });
    const facts = collectFacts(key.scenario, finalDir, p.initialSha, join(scratch, "checks"));
    writeFileSync(join(keep, "facts.json"), `${JSON.stringify(facts, null, 2)}\n`);

    const skillRead = readSkill(t);
    const status: RunStatus = postBlinding.length
      ? "blinding-violation"
      : r.timedOut
        ? "timeout"
        : t.toolCalls.length === 0 && (t.errors.length > 0 || t.finalText === "")
          ? "infra-error"
          : "ok";
    const meta: RunMeta = {
      id: key.id,
      scenario: key.scenario.id,
      subject: key.scenario.subject,
      variant: key.variant,
      rep: key.rep,
      model: key.scenario.model,
      thinking: CANDIDATE_THINKING,
      status,
      exitCode: r.exitCode,
      durationS: r.durationS,
      initialSha: p.initialSha,
      candidateCwd: p.projectDir,
      preBlinding,
      postBlinding,
      skillsAdvertised: (t.systemSections?.skills?.match(/<skill>/g) ?? []).length,
      skillReadLine: skillRead?.line ?? null,
      toolCalls: t.toolCalls.length,
      usage: t.usage,
      errors: t.errors,
    };
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${key.id}: ${status} in ${r.durationS}s, ${t.toolCalls.length} tool calls, skill ${skillRead ? "read" : "not read"}`);
  } finally {
    removeRoot(p.root);
  }
}

const loadMeta = (id: string) => JSON.parse(readFileSync(join(RUNS, id, "meta.json"), "utf8")) as RunMeta;
const loadFacts = (id: string) => JSON.parse(readFileSync(join(RUNS, id, "facts.json"), "utf8")) as RepoFacts;
const loadTranscript = (id: string) => parseTranscript(readFileSync(join(RUNS, id, "transcript.jsonl"), "utf8"));
const gradable = (key: RunKey) => existsSync(join(RUNS, key.id, "meta.json")) && ["ok", "timeout"].includes(loadMeta(key.id).status);

function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

type JudgeRecord = { scenario: string; criterion: string; mapping: Record<string, string>; verdicts: Record<string, Verdict>; attempts: number; transcript: string };

async function judgeScenario(s: Scenario): Promise<void> {
  const dir = join(RUNS, "judge", s.id);
  if (existsSync(join(dir, "verdicts.json"))) return console.log(`judge ${s.id}: kept`);
  const keys = plan(s.id).filter(gradable);
  const criterion = s.rubric.find((c) => c.kind === "judged");
  if (!criterion) throw new Error(`${s.id} has no judged criterion`);
  const labels = ["A", "B", "C", "D", "E", "F"].slice(0, keys.length);
  const order = shuffled(keys);
  const mapping = Object.fromEntries(order.map((k, i) => [labels[i]!, k.id]));
  const items = order.map((k, i) => ({
    label: labels[i]!,
    material: s.subject === "git-workflow" ? gitMaterial(loadFacts(k.id)) : verificationMaterial(loadTranscript(k.id)),
  }));
  const prompt = buildJudgePrompt(promptFor(s.id), criterion, items);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prompt.txt"), prompt);
  const cwd = join(SCRATCH, `judge-${s.id}`);
  mkdirSync(cwd, { recursive: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    recordLaunch("judge", `${s.id}.${attempt}`);
    const out = spawnSync("claude", ["-p", "--model", JUDGE_MODEL, "--output-format", "json", "--no-session-persistence", prompt], { cwd, encoding: "utf8", timeout: RUN_TIMEOUT_MS });
    writeFileSync(join(dir, `judge.${attempt}.json`), out.stdout ?? "");
    try {
      const reply = (JSON.parse(out.stdout) as { result?: string }).result ?? "";
      const verdicts = parseVerdicts(reply, labels);
      const record: JudgeRecord = {
        scenario: s.id,
        criterion: criterion.id,
        mapping,
        verdicts: Object.fromEntries(verdicts),
        attempts: attempt,
        transcript: rel(join(dir, `judge.${attempt}.json`)),
      };
      writeFileSync(join(dir, "verdicts.json"), `${JSON.stringify(record, null, 2)}\n`);
      return console.log(`judge ${s.id}: ${[...verdicts].map(([l, v]) => `${l}=${v.pass}`).join(" ")}`);
    } catch (error) {
      console.log(`judge ${s.id}: attempt ${attempt} unusable: ${(error as Error).message}`);
    }
  }
}

function judgeVerdictFor(s: Scenario, runId: string): { verdict: Verdict | undefined; ref: string } {
  const path = join(RUNS, "judge", s.id, "verdicts.json");
  if (!existsSync(path)) return { verdict: undefined, ref: rel(path) };
  const record = JSON.parse(readFileSync(path, "utf8")) as JudgeRecord;
  const label = Object.entries(record.mapping).find(([, id]) => id === runId)?.[0];
  return { verdict: label ? record.verdicts[label] : undefined, ref: `${record.transcript} (label ${label ?? "none"})` };
}

function cmdGrade(): void {
  const lines: string[] = [];
  const scores: Record<Subject, Record<Variant, number[]>> = {
    verification: { current: [], weakened: [] },
    "git-workflow": { current: [], weakened: [] },
    planning: { current: [], weakened: [] },
  };
  const targeted: Record<string, { met: number; of: number }> = {};
  for (const key of plan()) {
    if (!existsSync(join(RUNS, key.id, "meta.json"))) continue;
    const meta = loadMeta(key.id);
    if (!["ok", "timeout"].includes(meta.status)) {
      lines.push(JSON.stringify({ run: key.id, scenario: key.scenario.id, subject: key.scenario.subject, variant: key.variant, rep: key.rep, status: meta.status, counted: false }));
      continue;
    }
    const s = key.scenario;
    const facts = loadFacts(key.id);
    const transcriptRef = rel(join(RUNS, key.id, "transcript.jsonl"));
    const factsRef = rel(join(RUNS, key.id, "facts.json"));
    const { verdict, ref: judgeRef } = judgeVerdictFor(s, key.id);
    const criteria: CriterionResult[] =
      s.subject === "verification"
        ? gradeVerification(s, loadTranscript(key.id), facts, verdict, { transcript: transcriptRef, facts: factsRef, judge: judgeRef })
        : s.subject === "planning"
          ? gradePlanning(s, facts, verdict, { facts: factsRef, judge: judgeRef })
          : gradeGit(s, facts, verdict, { facts: factsRef, judge: judgeRef });
    const score = runScore(criteria);
    scores[s.subject][key.variant].push(score);
    for (const c of criteria.filter((x) => x.targeted)) {
      const k = `${s.subject}/${c.id}/${key.variant}`;
      targeted[k] = { met: (targeted[k]?.met ?? 0) + (c.pass ? 1 : 0), of: (targeted[k]?.of ?? 0) + 1 };
    }
    lines.push(
      JSON.stringify({
        run: key.id,
        scenario: s.id,
        subject: s.subject,
        variant: key.variant,
        rep: key.rep,
        status: meta.status,
        counted: true,
        model: meta.model,
        thinking: meta.thinking,
        duration_s: meta.durationS,
        tool_calls: meta.toolCalls,
        skill_read_line: meta.skillReadLine,
        usage: meta.usage,
        blinding: { pre: meta.preBlinding.length, post: meta.postBlinding.length },
        score,
        criteria,
        commits: facts.commits.map((c) => ({ subject: c.subject, body: c.body, files: c.files })),
        transcript: transcriptRef,
        facts: factsRef,
      }),
    );
  }
  writeFileSync(RESULTS, `${lines.join("\n")}\n`);
  const summary = (Object.keys(scores) as Subject[]).flatMap((subject) => {
    const v = scores[subject];
    if (!v.current.length || !v.weakened.length) return [];
    return [{ subject, current: v.current, weakened: v.weakened, ...acceptance(v.current, v.weakened) }];
  });
  writeFileSync(join(HERE, "summary.json"), `${JSON.stringify({ summary, targeted }, null, 2)}\n`);
  console.log(JSON.stringify({ summary, targeted }, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const only = rest.includes("--only") ? rest[rest.indexOf("--only") + 1] : undefined;
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(RUNS, { recursive: true });
  switch (command) {
    case "plan":
      return cmdPlan(only);
    case "candidates":
      return pool(plan(only), CONCURRENCY, runCandidate);
    case "judge":
      return pool([...SCENARIOS].filter((s) => !only || s.id === only), CONCURRENCY, judgeScenario);
    case "grade":
      return cmdGrade();
    default:
      throw new Error("usage: bun evals/skills/run.ts plan|candidates|judge|grade [--only <scenario>]");
  }
}

if (import.meta.main) await main();

