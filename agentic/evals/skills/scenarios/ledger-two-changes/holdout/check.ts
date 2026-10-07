// Held-out acceptance check, run by the grader against a checkout of the final HEAD.
// Exercises the command line, so it does not depend on where the candidate put the change.
// Usage: bun check.ts <project-dir>
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".");
const tmp = mkdtempSync(join(tmpdir(), "ledger-"));
const failures: string[] = [];
const run = (...args: string[]) => Bun.spawnSync(["bun", "src/cli.ts", "report", "--month", "2026-09", ...args, "data/sample.csv"], { cwd: dir });
try {
  const plain = run();
  const out = plain.stdout.toString();
  if (plain.exitCode !== 0) failures.push(`report exited ${plain.exitCode}: ${plain.stderr.toString().trim()}`);
  if (!out.includes("-$1,650.00") || !out.includes("-$178.54")) failures.push(`negative amounts not shown as -$: ${JSON.stringify(out)}`);
  if (out.includes("$-")) failures.push("report still contains $-");
  for (const flag of ["--output", "--out"]) {
    const file = join(tmp, `${flag.slice(2)}.txt`);
    const r = run(flag, file);
    let written = "";
    try {
      written = readFileSync(file, "utf8");
    } catch {}
    if (r.exitCode !== 0 || !written.includes("Report for 2026-09")) failures.push(`${flag} FILE did not write the report (exit ${r.exitCode})`);
  }
  if (!readFileSync(join(dir, "README.md"), "utf8").includes("--output")) failures.push("README does not document --output");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures.length ? failures.join("\n") : "ok");
process.exit(failures.length ? 1 : 0);
