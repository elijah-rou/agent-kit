import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const SCANNER = join(import.meta.dir, "scan-public-safety");
// Built from parts so this file never holds the literals it plants.
const PERSONAL_EMAIL = ["alice", "mail.test"].join("@");
const FORGE_NOREPLY_EMAIL = ["12345+bot", "users.noreply.github.com"].join("@");
const TRAILER_NOREPLY_EMAIL = ["noreply", "anthropic.com"].join("@");
const OTHER_NOREPLY_EMAIL = ["noreply", "vendor.test"].join("@");
const HOME = ["", "Users", "alice", "project"].join("/");
const TOKEN = "ghp" + "_" + "a".repeat(36);

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "scan-public-safety-"));
  directories.push(directory);
  return directory;
}

function scan(...args: string[]) {
  const result = Bun.spawnSync(["python3", SCANNER, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function repository(): string {
  const directory = scratch();
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", directory, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  return directory;
}

function commit(directory: string, file: string, email: string, message: string): void {
  writeFileSync(join(directory, file), "clean\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: email };
  for (const args of [["add", file], ["commit", "-q", "-m", message]]) {
    const result = Bun.spawnSync(["git", "-C", directory, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
}

describe("--paths scans evidence files and directories", () => {
  test("reports each planted identifier by location and kind, never echoing it", () => {
    const evidence = scratch();
    mkdirSync(join(evidence, "run-1"));
    writeFileSync(join(evidence, "run-1", "transcript.txt"), `ok\nsigned in as ${PERSONAL_EMAIL}\ncwd ${HOME}/src\ntoken=${TOKEN}\n`);
    writeFileSync(join(evidence, "summary.txt"), "PASS feature\n");
    const result = scan("--paths", evidence);
    expect(result.code).toBe(1);
    const location = join(basename(evidence), "run-1", "transcript.txt");
    expect(result.stderr).toContain(`${location}:2: personal email address`);
    expect(result.stderr).toContain(`${location}:3: literal user home path`);
    expect(result.stderr).toContain(`${location}:4: recognized token format`);
    expect(result.stderr).toContain("failed with 3 finding(s)");
    for (const literal of [PERSONAL_EMAIL, HOME, TOKEN, evidence]) expect(result.stderr + result.stdout).not.toContain(literal);
  });

  test("passes clean evidence and scans a link as its target text without following it", () => {
    const evidence = scratch();
    const outside = scratch();
    writeFileSync(join(outside, "secret.txt"), `${PERSONAL_EMAIL}\n`);
    writeFileSync(join(evidence, "log.txt"), `PASS feature\nmailed ${FORGE_NOREPLY_EMAIL}\n`);
    symlinkSync(join(outside, "secret.txt"), join(evidence, "linked.txt"));
    symlinkSync(outside, join(evidence, "linked-dir"));
    const result = scan("--paths", evidence);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("public-safety scan passed (paths)");
  });

  test("notes a binary file and fails on a missing path", () => {
    const evidence = scratch();
    writeFileSync(join(evidence, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const binary = scan("--paths", evidence);
    expect(binary.code).toBe(0);
    expect(binary.stderr).toContain("shot.png: binary file");
    const missing = scan("--paths", join(evidence, "absent"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no such file or directory");
  });

  test("a binary file over the scan limit gets the look-yourself note, a text file over it stays a finding", () => {
    const evidence = scratch();
    const recording = Buffer.alloc(2_000_001, 0x41);
    recording[4] = 0;
    writeFileSync(join(evidence, "run.mp4"), recording);
    const binary = scan("--paths", evidence);
    expect(binary.code).toBe(0);
    expect(binary.stderr).toContain("run.mp4: binary file over the 2000000 byte scan limit, not scanned; look at images and recordings yourself");
    writeFileSync(join(evidence, "huge.log"), "a".repeat(2_000_001));
    const text = scan("--paths", evidence);
    expect(text.code).toBe(1);
    expect(text.stderr).toContain("huge.log:1: paths blob exceeds 2000000 byte scan limit");
    expect(text.stderr).toContain("failed with 1 finding(s)");
  });

  test("a no-reply address at another domain is a finding outside commit metadata", () => {
    const evidence = scratch();
    writeFileSync(join(evidence, "log.txt"), `mailed ${OTHER_NOREPLY_EMAIL}\nco-author ${TRAILER_NOREPLY_EMAIL}\n`);
    const result = scan("--paths", evidence);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("log.txt:1: personal email address");
    expect(result.stderr).toContain("log.txt:2: personal email address");
  });
});

describe("--commits scans commit metadata", () => {
  test("flags a personal author address and passes the forge no-reply identity and the co-author trailer", () => {
    const directory = repository();
    commit(directory, "a.txt", FORGE_NOREPLY_EMAIL, `First\n\nCo-Authored-By: Bot <${TRAILER_NOREPLY_EMAIL}>`);
    const clean = scan("--repo", directory, "--commits", "HEAD");
    expect(clean.stderr).toBe("");
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain("public-safety scan passed (commits)");
    commit(directory, "b.txt", PERSONAL_EMAIL, `Second\n\nCo-authored-by: A <${PERSONAL_EMAIL}>`);
    const leaked = scan("--repo", directory, "--commits", "HEAD~1..HEAD");
    expect(leaked.code).toBe(1);
    expect(leaked.stderr).toMatch(/commit [0-9a-f]{12} author:1: personal email address/);
    expect(leaked.stderr).toMatch(/commit [0-9a-f]{12} committer:1: personal email address/);
    expect(leaked.stderr).toMatch(/commit [0-9a-f]{12} message:3: personal email address/);
    expect(leaked.stderr).not.toContain(PERSONAL_EMAIL);
  });

  test("exempts no-reply addresses only at the forge and the co-author trailer's address", () => {
    const directory = repository();
    commit(directory, "a.txt", OTHER_NOREPLY_EMAIL, "First");
    const result = scan("--repo", directory, "--commits", "HEAD");
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/commit [0-9a-f]{12} author:1: personal email address/);
  });
});

describe("--index and --worktree scan the named repository", () => {
  test("default index mode reads the staged blob, worktree mode the file on disk", () => {
    const directory = repository();
    commit(directory, "a.txt", FORGE_NOREPLY_EMAIL, "First");
    writeFileSync(join(directory, "a.txt"), `${PERSONAL_EMAIL}\n`);
    expect(scan("--repo", directory).code).toBe(0);
    const worktree = scan("--repo", directory, "--worktree");
    expect(worktree.code).toBe(1);
    expect(worktree.stderr).toContain("a.txt:1: personal email address");
  });

  test("index mode still fails a no-reply address at another domain and the trailer's address", () => {
    const directory = repository();
    commit(directory, "a.txt", FORGE_NOREPLY_EMAIL, "First");
    writeFileSync(join(directory, "b.txt"), `${OTHER_NOREPLY_EMAIL}\n${TRAILER_NOREPLY_EMAIL}\n`);
    const add = Bun.spawnSync(["git", "-C", directory, "add", "b.txt"], { stdout: "pipe", stderr: "pipe" });
    expect(add.exitCode).toBe(0);
    const result = scan("--repo", directory, "--index");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("b.txt:1: personal email address");
    expect(result.stderr).toContain("b.txt:2: personal email address");
  });
});
