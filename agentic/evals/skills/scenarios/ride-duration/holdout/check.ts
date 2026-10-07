// Held-out acceptance check, run by the grader against the final workspace.
// Usage: bun check.ts <project-dir>
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? ".");
const { formatDuration } = (await import(join(dir, "src/duration.ts"))) as { formatDuration: (s: number) => string };
const cases: [number, string][] = [
  [0, "0m"], [29, "0m"], [30, "1m"], [45, "1m"], [2290, "38m"], [3569, "59m"], [3570, "1h 0m"], [3599, "1h 0m"],
  [3600, "1h 0m"], [5400, "1h 30m"], [7170, "2h 0m"], [7199, "2h 0m"], [7140, "1h 59m"], [17_250, "4h 48m"],
];
const failures = cases.flatMap(([s, want]) => {
  const got = formatDuration(s);
  return got === want ? [] : [`formatDuration(${s}) = ${got}, want ${want}`];
});
for (const bad of [-1, 1.5]) {
  try {
    formatDuration(bad);
    failures.push(`formatDuration(${bad}) did not throw`);
  } catch {}
}
console.log(failures.length ? failures.join("\n") : "ok");
process.exit(failures.length ? 1 : 0);
