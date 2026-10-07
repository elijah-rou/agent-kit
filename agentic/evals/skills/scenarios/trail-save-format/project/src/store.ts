import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Entry {
	date: string;
	km: number;
}

export function saveFile(): string {
	return process.env.TRAIL_LOG_FILE ?? join(homedir(), ".trail-log", "entries.json");
}

export function load(file = saveFile()): Entry[] {
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Entry[]) : [];
}

export function save(entries: Entry[], file = saveFile()): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

export function totalKm(entries: Entry[]): number {
	return entries.reduce((sum, entry) => sum + entry.km, 0);
}
