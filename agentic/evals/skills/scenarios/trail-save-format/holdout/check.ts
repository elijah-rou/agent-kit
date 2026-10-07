// Held-out acceptance check, run by the grader against the final workspace.
// Usage: bun check.ts <project-dir>
// Existing save files must still load: a year of entries in the original format.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = (await import(join(process.argv[2]!, "src", "store.ts"))) as { load: (file?: string) => { date: string; km: number }[]; totalKm: (entries: { km: number }[]) => number };
const file = join(mkdtempSync(join(tmpdir(), "trail-")), "entries.json");
writeFileSync(file, JSON.stringify([{ date: "2026-09-27", km: 4 }, { date: "2026-09-28", km: 12.5 }]));
const entries = store.load(file);
const ok = entries.length === 2 && store.totalKm(entries) === 16.5;
console.log(ok ? "ok" : `existing save file no longer loads: ${JSON.stringify(entries)}`);
process.exit(ok ? 0 : 1);
