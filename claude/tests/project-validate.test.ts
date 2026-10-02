// Exercises the shipped validation runner in disposable Unix workspaces.
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = join(import.meta.dir, "../mods/trial-tools/hooks/project-validate.ts");
type Result = Record<string, any>;

function invoke(directory: string, command?: string, options: { action?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): Result {
  const args = [RUNNER, "--action", options.action ?? "test", "--cwd", directory, "--timeout-ms", String(options.timeout ?? 120000), "--actor", "root-or-user"];
  if (command !== undefined) args.push("--command", command);
  const result = spawnSync("bun", args, { input: "", encoding: "utf8", timeout: 15000, env: options.env ?? process.env });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
const digestOf = (directory: string) => invoke(directory, "true").verificationReceipt.workspaceBefore;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
}
async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) await sleep(20);
  expect(existsSync(path)).toBe(true);
}
async function runAndSignal(args: string[], signal: NodeJS.Signals, ready: string, env = process.env): Promise<Result> {
  const child = spawn("bun", [RUNNER, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const exited = new Promise<number | null>(done => child.on("close", done));
  try {
    await waitFor(ready);
    child.kill(signal);
    const code = await Promise.race([exited, sleep(5000).then(() => "timeout")]);
    expect(code).toBe(0);
    return JSON.parse(stdout);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "claude-validation-")));
const directory = join(temporary, "workspace with 'quotes'");
mkdirSync(directory);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(...args: string[]): void {
  const result = spawnSync("git", ["-C", directory, ...args], { input: "", encoding: "utf8", env: gitEnv, timeout: 10000 });
  expect(result.status, result.stderr).toBe(0);
}
const tracked = join(directory, "tracked.txt");
writeFileSync(tracked, "seed\n");
git("init", "-b", "main");
git("add", "tracked.txt");
git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "fixture");

test("exit codes, diagnostics, and receipts", () => {
  const passed = invoke(directory, "printf 'passed\\n'");
  expect(passed.outcome).toBe("passed");
  expect(passed.exitCode).toBe(0);
  const receipt = passed.verificationReceipt;
  expect(receipt.version).toBe(1);
  expect(receipt.workspaceStable).toBe(true);
  expect(receipt.workspaceBefore.state).toBe("available");
  expect(receipt.workspaceBefore.digest).toHaveLength(64);
  expect(receipt.workspaceBefore).toEqual(receipt.workspaceAfter);
  expect(receipt.authority).toBe("local-verification");
  const failed = invoke(directory, "printf 'E100 error fixture\\n'; exit 7");
  expect(failed.outcome).toBe("failed");
  expect(failed.exitCode).toBe(7);
  expect(String(failed.summary)).toContain("E100 error fixture");
  expect(failed.verificationReceipt.attemptId).not.toBe(receipt.attemptId);
  const mutated = invoke(directory, "printf changed > tracked.txt");
  expect(mutated.outcome).toBe("passed");
  expect(mutated.verificationReceipt.workspaceStable).toBe(false);
  expect(String(mutated.residualGaps)).toContain("changed");
  writeFileSync(tracked, "seed\n");
});

test("fingerprints raw index, untracked bytes, and modes", () => {
  const stagedBefore = digestOf(directory).digest;
  writeFileSync(tracked, "changed\n");
  git("add", "tracked.txt");
  expect(digestOf(directory).digest).not.toBe(stagedBefore);
  git("reset", "--hard", "HEAD");
  const untracked = join(directory, "untracked.txt");
  writeFileSync(untracked, "one");
  const first = digestOf(directory).digest;
  writeFileSync(untracked, "two");
  const second = digestOf(directory).digest;
  expect(second).not.toBe(first);
  chmodSync(untracked, 0o700);
  expect(digestOf(directory).digest).not.toBe(second);
  unlinkSync(untracked);
  git("config", "core.autocrlf", "true");
  writeFileSync(tracked, "seed\r\n");
  const crlf = digestOf(directory).digest;
  writeFileSync(tracked, "seed\n");
  expect(digestOf(directory).digest).not.toBe(crlf);
  git("config", "core.autocrlf", "false");
  const outside = join(temporary, "outside.txt");
  writeFileSync(outside, "do not read outside the workspace");
  symlinkSync(outside, join(directory, "linked.txt"));
  const linked = digestOf(directory);
  expect(linked.state).toBe("unavailable");
  expect(String(linked.reason)).toContain("regular");
  unlinkSync(join(directory, "linked.txt"));
});

test("bounds output and stops the process group on timeout", () => {
  const large = invoke(directory, `awk 'BEGIN { for (i = 0; i < 1000000; i++) printf "x"; print ""; print "tail marker" }'`);
  expect(large.truncated).toBe(true);
  expect(String(large.output).length).toBeLessThanOrEqual(30100);
  expect(String(large.output)).toContain("tail marker");
  const timed = invoke(directory, "sleep 20 & echo $!; wait", { timeout: 1000 });
  expect(timed.outcome).toBe("timed_out");
  expect(running(Number(String(timed.output).trim()))).toBe(false);
});

test("SIGINT during fingerprinting cancels before the command runs", async () => {
  const slowBin = join(temporary, "slow-bin");
  mkdirSync(slowBin);
  const pidFile = join(temporary, "git.pid");
  const marker = join(temporary, "must-not-launch");
  writeFileSync(join(slowBin, "git"), `#!/bin/sh\necho $$ > '${pidFile}'\nsleep 20\n`, { mode: 0o700 });
  const result = await runAndSignal(["--action", "test", "--cwd", directory, "--command", `printf unexpected > '${marker}'`], "SIGINT", pidFile,
    { ...process.env, PATH: `${slowBin}:${process.env.PATH}` });
  expect(result.outcome).toBe("cancelled");
  expect(existsSync(marker)).toBe(false);
  expect(running(Number(readFileSync(pidFile, "utf8").trim()))).toBe(false);
});

test("SIGTERM cancels the command and its children", async () => {
  const result = await runAndSignal(["--action", "test", "--cwd", directory, "--command", "echo $$ > leader.pid; sleep 20 & echo $! > child.pid; wait"], "SIGTERM", join(directory, "child.pid"));
  expect(result.outcome).toBe("cancelled");
  expect(running(Number(readFileSync(join(directory, "child.pid"), "utf8").trim()))).toBe(false);
  unlinkSync(join(directory, "leader.pid"));
  unlinkSync(join(directory, "child.pid"));
});

test("discovers the project runner and reports unsupported projects", () => {
  writeFileSync(join(directory, "Makefile"), "test:\n\t@printf 'automatic fixture\\n'\n");
  const nested = join(directory, "nested");
  mkdirSync(nested);
  const automatic = invoke(nested);
  expect(automatic.outcome).toBe("passed");
  expect(automatic.cwd).toBe(directory);
  expect(String(automatic.output)).toContain("automatic fixture");
  const explicit = invoke(nested, "pwd");
  expect(explicit.cwd).toBe(nested);
  expect(String(explicit.output)).toContain(nested);
  const empty = join(temporary, "empty");
  mkdirSync(empty);
  const unsupported = invoke(empty);
  expect(unsupported.outcome).toBe("unsupported");
  expect(unsupported.verificationReceipt.workspaceStable).toBeNull();
  unlinkSync(join(directory, "Makefile"));
  rmSync(nested, { recursive: true });
});

test("workspace byte and file-count limits are exact", () => {
  const limit = join(directory, "byte-limit");
  writeFileSync(limit, "");
  truncateSync(limit, 10 * 1048576);
  expect(digestOf(directory).state).toBe("available");
  appendFileSync(limit, "x");
  expect(digestOf(directory).state).toBe("unavailable");
  unlinkSync(limit);
  for (let index = 0; index < 100; index++) writeFileSync(join(directory, `file-${index}`), "small");
  expect(digestOf(directory).state).toBe("available");
  writeFileSync(join(directory, "file-100"), "adjacent count limit");
  const limited = digestOf(directory);
  expect(limited.state).toBe("unavailable");
  expect(String(limited.reason)).toContain("limit");
});

test("uv projects run through uv without syncing or downloading", () => {
  const project = join(temporary, "uv-project");
  mkdirSync(project);
  writeFileSync(join(project, "uv.lock"), "fixture");
  const fakeBin = join(temporary, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "uv"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });
  for (const [action, selected] of [["test", "pytest"], ["lint", "ruff"], ["typecheck", "pyright"]] as const) {
    const result = invoke(project, undefined, { action, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
    expect(result.outcome).toBe("passed");
    expect(String(result.output).split("\n").slice(0, 4)).toEqual(["run", "--frozen", "--no-sync", "--no-python-downloads"]);
    expect(String(result.output)).toContain(selected);
  }
});

test("rejects out-of-range or malformed timeouts", () => {
  for (const value of ["0", "999", "300001", "1.5", "nan", "inf", "bad"]) {
    const result = spawnSync("bun", [RUNNER, "--action", "test", "--cwd", directory, "--timeout-ms", value], { input: "", timeout: 5000 });
    expect(result.status).not.toBe(0);
  }
});
