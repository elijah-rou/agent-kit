#!/usr/bin/env bun
// Bound validation and return observed workspace evidence, not authorization.
// Usage: bun project-validate.ts --action test|lint|typecheck --cwd DIR [--command CMD] [--timeout-ms N] [--actor NAME]
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

type Action = "test" | "lint" | "typecheck";
type Outcome = "passed" | "failed" | "timed_out" | "cancelled" | "execution_error" | "unsupported";
type RunResult = { outcome: Outcome; exitCode: number | null; output: Buffer; truncated: boolean; elapsedMs: number };
type Fingerprint =
  | { state: "available"; repositoryRoot: string; head: string; digest: string }
  | { state: "unavailable"; repositoryRoot: string; reason: string };

const ACTIONS: readonly Action[] = ["test", "lint", "typecheck"];
const MAX_OUTPUT_BYTES = 30_000;
const MAX_GIT_BYTES = 1_048_576;
const MAX_UNTRACKED_FILES = 100;
const MAX_UNTRACKED_BYTES = 10 * 1_048_576;
const MAX_WORKSPACE_FILES = 1000;
const MAX_WORKSPACE_BYTES = 20 * 1_048_576;
const GIT_PREFIX = ["git", "--no-pager", "--no-optional-locks", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MARKERS = ["package.json", "bun.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.toml", "go.mod", "pyproject.toml", "uv.lock", "Makefile", "justfile"];

class Cancelled extends Error {}

// Process groups this invocation created. Only these are ever signalled.
const ownedGroups = new Set<number>();
let cancelled = false;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* the group has already exited */ }
}

async function stopGroup(child: ChildProcess, exited: Promise<number | null>): Promise<number | null> {
  const pid = child.pid;
  if (pid === undefined) return exited;
  signalGroup(pid, "SIGTERM");
  const settled = await Promise.race([exited, new Promise<"pending">(done => setTimeout(() => done("pending"), 200))]);
  signalGroup(pid, "SIGKILL");
  ownedGroups.delete(pid);
  return settled === "pending" ? await Promise.race([exited, new Promise<null>(done => setTimeout(() => done(null), 2000))]) : settled;
}

async function run(argv: string[], cwd: string, timeoutMs: number, limit: number): Promise<RunResult> {
  if (argv.length === 0 || timeoutMs <= 0 || limit <= 0) throw new Error("run needs a command, a timeout, and a limit");
  if (cancelled) throw new Cancelled();
  const started = performance.now();
  const headLimit = Math.floor(limit / 3);
  const tailLimit = limit - headLimit;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;
  let child: ChildProcess;
  try {
    child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (error) {
    return { outcome: "execution_error", exitCode: null, output: Buffer.from(String(error)).subarray(0, limit), truncated: false, elapsedMs: 0 };
  }
  if (child.pid !== undefined) ownedGroups.add(child.pid);
  const collect = (chunk: Buffer) => {
    total += chunk.length;
    const room = Math.max(headLimit - head.length, 0);
    head = Buffer.concat([head, chunk.subarray(0, room)]);
    tail = Buffer.concat([tail, chunk.subarray(room)]);
    if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit);
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  let launchError: Error | undefined;
  const exited = new Promise<number | null>(done => {
    child.on("error", error => { launchError = error; done(null); });
    child.on("close", code => done(code));
  });
  const timer = new Promise<"timeout">(done => setTimeout(() => done("timeout"), timeoutMs).unref());
  const finished = await Promise.race([exited, timer, cancellation]);
  let outcome: Outcome;
  let exitCode: number | null;
  if (finished === "timeout" || finished === "cancelled") {
    exitCode = await stopGroup(child, exited);
    if (finished === "cancelled") throw new Cancelled();
    outcome = "timed_out";
  } else {
    exitCode = finished;
    // The leader exited; anything it left running in its group is still ours to stop.
    await stopGroup(child, exited);
    outcome = launchError !== undefined ? "execution_error" : exitCode === 0 ? "passed" : "failed";
  }
  if (launchError !== undefined) head = Buffer.from(launchError.message).subarray(0, limit);
  const truncated = total > limit;
  const output = Buffer.concat([head, truncated ? Buffer.from("\n[... truncated ...]\n") : Buffer.alloc(0), tail]);
  return { outcome, exitCode, output, truncated, elapsedMs: Math.round(performance.now() - started) };
}

let cancel: (value: "cancelled") => void = () => {};
const cancellation = new Promise<"cancelled">(done => { cancel = done; });

function git(cwd: string, ...args: string[]): Promise<RunResult> {
  return run([...GIT_PREFIX, "-C", cwd, ...args], cwd, 3000, MAX_GIT_BYTES);
}

async function repository(cwd: string): Promise<string | null> {
  const result = await git(cwd, "rev-parse", "--show-toplevel");
  if (result.outcome !== "passed" || result.truncated) return null;
  try { return realpathSync(result.output.toString("utf8").trim()); } catch { return null; }
}

function u64(value: number | bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function splitNul(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] === 0) { if (index > start) parts.push(data.subarray(start, index)); start = index + 1; }
  }
  if (start < data.length) parts.push(data.subarray(start));
  return parts;
}

async function fingerprint(cwd: string): Promise<Fingerprint> {
  const root = await repository(cwd);
  if (root === null) return { state: "unavailable", repositoryRoot: cwd, reason: "Git workspace unreadable or absent" };
  const unavailable = (reason: string): Fingerprint => ({ state: "unavailable", repositoryRoot: root, reason });
  const digest = createHash("sha256").update(root);
  try {
    const metadata: Buffer[] = [];
    // Reading the index and raw bytes avoids clean/textconv filters and normalized-diff collisions.
    for (const args of [["rev-parse", "--verify", "HEAD"], ["ls-files", "--stage", "-z"], ["ls-files", "--others", "--exclude-standard", "-z"]]) {
      const result = await git(root, ...args);
      if (result.outcome !== "passed" || result.truncated) return unavailable("Git fingerprint output unavailable or over limit");
      metadata.push(result.output);
      digest.update(u64(result.output.length)).update(result.output);
    }
    const head = metadata[0]!.toString("utf8").trim();
    const tracked = new Set<string>();
    for (const entry of splitNul(metadata[1]!)) {
      const tab = entry.indexOf(9);
      if (entry.subarray(0, 7).toString() === "160000 ") return unavailable("submodule content is not fingerprinted");
      tracked.add(entry.subarray(tab + 1).toString("utf8"));
    }
    const untracked = new Set(splitNul(metadata[2]!).map(path => path.toString("utf8")));
    const all = [...new Set([...tracked, ...untracked])].sort();
    if (untracked.size > MAX_UNTRACKED_FILES) return unavailable("untracked file count limit exceeded");
    if (all.length > MAX_WORKSPACE_FILES) return unavailable("workspace file count limit exceeded");
    let byteCount = 0;
    let untrackedBytes = 0;
    for (const name of all) {
      const path = join(root, name);
      const parent = realpathSync(dirname(path));
      if (parent !== root && !parent.startsWith(root + sep)) return unavailable("file path escapes workspace");
      const encoded = Buffer.from(name, "utf8");
      digest.update(u64(encoded.length)).update(encoded);
      let descriptor: number;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          if (untracked.has(name)) return unavailable("untracked file disappeared while observed");
          digest.update("missing\0");
          continue;
        }
        if (code === "ELOOP") return unavailable("workspace entry is not a regular file");
        throw error;
      }
      try {
        const before = fstatSync(descriptor, { bigint: true });
        if (!before.isFile()) return unavailable("workspace entry is not a regular file");
        const size = Number(before.size);
        byteCount += size;
        if (untracked.has(name)) untrackedBytes += size;
        if (byteCount > MAX_WORKSPACE_BYTES || untrackedBytes > MAX_UNTRACKED_BYTES) return unavailable("workspace or untracked byte limit exceeded");
        const content = Buffer.alloc(size + 1);
        let read = 0;
        while (read <= size) {
          const count = readSync(descriptor, content, read, size + 1 - read, null);
          if (count === 0) break;
          read += count;
        }
        const after = fstatSync(descriptor, { bigint: true });
        const same = before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
        if (read !== size || !same) return unavailable("workspace file changed while observed");
        const mode = Buffer.alloc(4);
        mode.writeUInt32BE(Number(before.mode & 0o7777n));
        digest.update("regular\0").update(mode).update(u64(size)).update(content.subarray(0, size));
      } finally {
        closeSync(descriptor);
      }
    }
    return { state: "available", repositoryRoot: root, head, digest: digest.digest("hex") };
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    return unavailable("workspace entry unreadable or not a regular file");
  }
}

async function discover(cwd: string): Promise<string> {
  const boundary = (await repository(cwd)) ?? cwd;
  let current = cwd;
  for (let depth = 0; depth < 32; depth++) {
    if (MARKERS.some(marker => { try { return statSync(join(current, marker)).isFile(); } catch { return false; } })) return current;
    if (current === boundary || dirname(current) === current) return current;
    current = dirname(current);
  }
  return cwd;
}

function commandFor(root: string, action: Action): string | null {
  const has = (name: string) => existsSync(join(root, name)) && statSync(join(root, name)).isFile();
  if (has("package.json")) {
    const runner = has("bun.lock") ? "bun run" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm run";
    return `${runner} ${action}`;
  }
  if (has("Cargo.toml")) return { test: "cargo test", lint: "cargo clippy --all-targets --all-features -- -D warnings", typecheck: "cargo check --all-targets --all-features" }[action];
  if (has("go.mod")) return action === "lint" ? "go vet ./..." : "go test ./...";
  if (has("pyproject.toml") || has("uv.lock")) return (has("uv.lock") ? "uv run --frozen --no-sync --no-python-downloads " : "") + { test: "pytest", lint: "ruff check .", typecheck: "pyright" }[action];
  if (has("Makefile")) return `make ${action}`;
  if (has("justfile")) return `just ${action}`;
  return null;
}

async function validate(action: Action, cwd: string, command: string | undefined, timeoutMs: number, actor: string) {
  let root = realpathSync(resolve(cwd));
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);
  if (command === undefined) root = await discover(root);
  const selected = command !== undefined ? command.trim() : commandFor(root, action);
  const before = await fingerprint(root);
  const startedAt = new Date().toISOString();
  const result: RunResult = selected === null
    ? { outcome: "unsupported", exitCode: null, output: Buffer.from("No automatic validation command detected; pass command explicitly."), truncated: false, elapsedMs: 0 }
    : await run(["/bin/sh", "-c", selected], root, timeoutMs, MAX_OUTPUT_BYTES);
  const after = await fingerprint(root);
  const stable = before.state === "available" && after.state === "available" ? JSON.stringify(before) === JSON.stringify(after) : null;
  const gaps: string[] = [];
  if (stable === false) gaps.push("Workspace changed between observations; this receipt cannot identify one unchanged revision.");
  if (stable === null) gaps.push("Workspace fingerprint unavailable; no content-equivalence claim.");
  if (result.truncated) gaps.push("Output truncated; full diagnostics were not retained.");
  const output = new TextDecoder("utf-8", { fatal: false }).decode(result.output).trim();
  const failure = /error|fail(?:ed|ure)?|panic|exception|assert|\bE\d{3,4}\b|\bTS\d{4}\b/i;
  const lines = output.split(/\r?\n/);
  let summary = result.outcome !== "passed" ? lines.filter(line => failure.test(line)).slice(0, 40) : [];
  if (summary.length === 0) summary = result.outcome === "passed" ? ["Command exited zero; inspect output and receipt gaps."] : lines.slice(-20);
  const receipt = {
    version: 1, attemptId: randomUUID(), authority: "local-verification", verifier: actor, startedAt, finishedAt: new Date().toISOString(),
    tool: "project_validate", action, command: selected, cwd: root, outcome: result.outcome, exitCode: result.exitCode,
    workspaceBefore: before, workspaceAfter: after, workspaceStable: stable,
    coverage: "HEAD, index entries, tracked/nonignored untracked raw regular-file bytes and modes; excludes ignored files, dependencies and environment; observations are not atomic",
    artifacts: [], residualGaps: gaps,
  };
  return { outcome: result.outcome, action, command: selected, cwd: root, exitCode: result.exitCode, elapsedMs: result.elapsedMs, truncated: result.truncated, summary, output, residualGaps: gaps, verificationReceipt: receipt };
}

function parseArguments(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!;
    const value = argv[index + 1];
    if (!["--action", "--cwd", "--command", "--timeout-ms", "--actor"].includes(key) || value === undefined) throw new Error(`unknown or incomplete argument: ${key}`);
    values.set(key, value);
  }
  const action = ACTIONS.find(candidate => candidate === values.get("--action"));
  const cwd = values.get("--cwd");
  const command = values.get("--command");
  const timeoutText = values.get("--timeout-ms") ?? "120000";
  const timeoutMs = /^\d+$/.test(timeoutText) ? Number(timeoutText) : Number.NaN;
  if (action === undefined || cwd === undefined) throw new Error("--action test|lint|typecheck and --cwd are required");
  if (!(timeoutMs >= 1000 && timeoutMs <= 300_000) || (command !== undefined && !(command.trim().length > 0 && command.length <= 8192))) {
    throw new Error("timeout must be 1000..300000 ms and command must contain 1..8192 characters");
  }
  return { action, cwd, command, timeoutMs, actor: values.get("--actor") ?? "unknown" };
}

let parsed: ReturnType<typeof parseArguments>;
try {
  parsed = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`project-validate: ${(error as Error).message}\n`);
  process.exit(2);
}

// A termination request stops owned process groups and still reports a structured result.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (cancelled) return;
    cancelled = true;
    cancel("cancelled");
  });
}

let result: object;
try {
  result = await validate(parsed.action, parsed.cwd, parsed.command, parsed.timeoutMs, parsed.actor);
} catch (error) {
  for (const pid of ownedGroups) signalGroup(pid, "SIGKILL");
  result = error instanceof Cancelled || cancelled
    ? { outcome: "cancelled", verificationReceipt: null, error: "Validation interrupted; no completed workspace receipt" }
    : { outcome: "execution_error", verificationReceipt: null, error: String((error as Error).message ?? error) };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
