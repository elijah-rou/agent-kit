// Runs the mod inside a real Claude Code CLI: /changes with real Git and a malicious-config fixture, and
// native /validate through Bash permissions, all with zero model usage. Skipped when `claude` is absent.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claude = Bun.which("claude");
const MOD = join(import.meta.dir, "../mods/trial-tools");

test.skipIf(claude === null)("native /changes and /validate run without model usage or side effects", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-tools-runtime-")));
  const repository = join(directory, "repository");
  mkdirSync(repository);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" };
  const git = (...args: string[]) => {
    const input = args[0] === "--input" ? args.splice(0, 2)[1] : "";
    const result = spawnSync("git", ["-C", repository, ...args], { input, encoding: "utf8", env, timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };

  git("init", "-b", "main");
  const marker = join(directory, "verifier-called");
  const verifier = join(directory, "verifier");
  writeFileSync(verifier, `#!/bin/sh\nprintf called >> '${marker}'\nexit 1\n`, { mode: 0o700 });
  const tracked = join(repository, "tracked.txt");
  writeFileSync(tracked, "fixture\n");
  git("add", "tracked.txt");
  const tree = git("write-tree");
  const commit = `tree ${tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake-signature\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`;
  const identifier = git("--input", commit, "hash-object", "-t", "commit", "-w", "--stdin");
  git("update-ref", "refs/heads/main", identifier);
  git("config", "log.showSignature", "true");
  git("config", "gpg.program", verifier);
  git("log", "--oneline", "-5");
  expect(existsSync(marker)).toBe(true); // the fixture reproduces verifier execution
  unlinkSync(marker);

  const captured = spawnSync(claude!, ["plugin", "test", MOD], { input: "", encoding: "utf8", env, timeout: 30_000 });
  expect(captured.status, captured.stdout + captured.stderr).toBe(0);
  const rows = (captured.stdout + captured.stderr).split("\n").filter(line => line.startsWith("TRIAL_TOOLS_GIT_ARGS=")).map(line => line.slice("TRIAL_TOOLS_GIT_ARGS=".length));
  expect(rows).toHaveLength(1);
  const queries = JSON.parse(rows[0]!) as string[][];
  expect(queries).toHaveLength(6);
  const index = join(repository, ".git/index");
  const previousIndex = readFileSync(index);
  utimesSync(tracked, 1_700_000_000, 1_700_000_000);
  git("status", "--short");
  expect(readFileSync(index).equals(previousIndex)).toBe(false); // the fixture reproduces Git's optional index refresh
  const expectedIndex = readFileSync(index);
  utimesSync(tracked, 1_700_000_001, 1_700_000_001);
  for (const argv of queries) {
    expect(argv.length >= 2 && argv.length <= 32 && argv[0] === "git" && argv.every(value => typeof value === "string")).toBe(true);
    const query = spawnSync(argv[0]!, argv.slice(1), { cwd: repository, env, encoding: "utf8", timeout: 10_000 });
    expect(query.status, query.stderr).toBe(0);
    expect(readFileSync(index).equals(expectedIndex)).toBe(true);
  }
  expect(existsSync(marker)).toBe(false);
  const before = git("--no-optional-locks", "status", "--porcelain=v1");

  // A disposable profile that loads the mod the way bootstrap links it.
  const profile = join(directory, "profile");
  mkdirSync(join(profile, "skills"), { recursive: true });
  symlinkSync(MOD, join(profile, "skills/trial-tools"));
  writeFileSync(join(profile, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1" } }));
  env.CLAUDE_CONFIG_DIR = profile;
  const ask = (prompt: string, ...flags: string[]) => {
    const result = spawnSync(claude!, ["--print", prompt, ...flags, "--output-format", "json", "--no-session-persistence", "--max-budget-usd", "0.01"], { input: "", encoding: "utf8", cwd: repository, env, timeout: 40_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.total_cost_usd).toBe(0);
    expect(response.modelUsage).toEqual({});
    return response;
  };

  const changes = ask("/changes");
  expect(changes.result).toContain("## Recent commits");
  expect(changes.result).toContain("signed fixture");
  expect(changes.usage.input_tokens).toBe(0);
  expect(changes.usage.output_tokens).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(git("--no-optional-locks", "status", "--porcelain=v1")).toBe(before);
  expect(readFileSync(index).equals(expectedIndex)).toBe(true);
  expect(git("rev-parse", "HEAD")).toBe(identifier);

  const evidence = (response: { result: string }) => {
    expect(response.result.startsWith("trial-tools: {")).toBe(true);
    return JSON.parse(response.result.slice("trial-tools: ".length));
  };
  const passed = evidence(ask(`/validate ${JSON.stringify({ action: "test", command: "printf 'native validation fixture\\n'" })}`, "--allowedTools", "Bash"));
  expect(passed.outcome).toBe("passed");
  expect(passed.exitCode).toBe(0);
  expect(passed.output).toContain("native validation fixture");
  expect(passed.verificationReceipt.workspaceStable).toBe(true);
  expect(existsSync(marker)).toBe(false);
  const deniedMarker = join(directory, "denied-command-marker");
  expect(evidence(ask(`/validate ${JSON.stringify({ action: "test", command: "printf 'native failure\\n'; exit 7" })}`, "--allowedTools", "Bash")).outcome).toBe("failed");
  expect(evidence(ask(`/validate ${JSON.stringify({ action: "test", command: `printf should-not-run > '${deniedMarker}'` })}`, "--permission-mode", "dontAsk")).outcome).toBe("denied");
  expect(existsSync(deniedMarker)).toBe(false);
}, 240_000);
