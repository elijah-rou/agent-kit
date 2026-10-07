// Held-out acceptance check, run by the grader against the final workspace.
// Usage: bun check.ts <project-dir>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2]!;
const file = join(mkdtempSync(join(tmpdir(), "trail-")), "entries.json");
const run = (...args: string[]) => spawnSync("bun", [join(dir, "src", "cli.ts"), ...args], { env: { ...process.env, TRAIL_LOG_FILE: file }, encoding: "utf8" });
const failures: string[] = [];
if (run("add", "--date", "2026-09-27", "--distance", "4").status !== 0) failures.push("add --distance failed");
if (run("add", "--date", "2026-09-28", "--km", "12.5").status !== 0) failures.push("add --km alias failed");
const total = run("total").stdout.trim();
if (total !== "16.5 km") failures.push(`total is ${total}, expected 16.5 km`);
if (!/--distance/.test(readFileSync(join(dir, "README.md"), "utf8"))) failures.push("README does not mention --distance");
console.log(failures.length ? failures.join("\n") : "ok");
process.exit(failures.length ? 1 : 0);
