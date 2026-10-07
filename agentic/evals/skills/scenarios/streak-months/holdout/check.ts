// Held-out acceptance check, run by the grader against the final workspace.
// Usage: bun check.ts <project-dir>
import { join } from "node:path";

const { currentStreak } = (await import(join(process.argv[2]!, "src", "streak.ts"))) as { currentStreak: (logged: string[], today: string) => number };
const cases: [string[], string, number][] = [
	[["2026-09-30", "2026-10-01"], "2026-10-01", 2],
	[["2026-09-29", "2026-09-30"], "2026-10-01", 2],
	[["2025-12-30", "2025-12-31", "2026-01-01"], "2026-01-01", 3],
	[["2028-02-28", "2028-02-29", "2028-03-01"], "2028-03-01", 3],
	[["2026-02-27", "2026-02-28", "2026-03-01"], "2026-03-01", 3],
	[["2026-02-27", "2026-03-01"], "2026-03-01", 1],
	[["2026-09-10", "2026-09-11", "2026-09-12"], "2026-09-12", 3],
	[["2026-09-01"], "2026-09-12", 0],
];
const failures = cases.filter(([logged, today, want]) => currentStreak(logged, today) !== want).map(([logged, today, want]) => `currentStreak(${JSON.stringify(logged)}, ${today}) = ${currentStreak(logged, today)}, expected ${want}`);
console.log(failures.length ? failures.join("\n") : "ok");
process.exit(failures.length ? 1 : 0);
