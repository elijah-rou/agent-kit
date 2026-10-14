// The route report: how each task-route note fared over a window of the local ledger, per runtime,
// and how many corrections the user recorded in sessions that got a note. It reads only local files
// (the ledger and this repository's correction records) and prints counts, never prompt or
// correction text. readLedger and readCorrections do the I/O; buildReport and formatReport are pure.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD_MAX, recordText, type Fallback, type RouteRecord, type Runtime } from "./route-task.ts";
import type { NoteId, Route } from "./route.ts";

export const DAY_MS = 86_400_000;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 366;
const NOTES: readonly NoteId[] = ["door", "lookup", "loop"];
const RUNTIMES: readonly Runtime[] = ["claude", "codex", "pi", "cli"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLevel = (v: unknown) => v === "lookup" || v === "rigor" || v === "loop";
const isRoute = (v: unknown): v is Route => isObject(v) && isLevel(v.level) && (v.door === undefined || (isObject(v.door) && typeof v.door.choice === "string"));
const isAnswer = (v: unknown) => isObject(v) && typeof v.choice === "string" && typeof v.confidence === "number" && Number.isFinite(v.confidence);

/** One ledger line as a record, or undefined for a line this reader does not understand. */
export function parseRecord(line: string): RouteRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isObject(raw) || raw.v !== 1) return undefined;
	const { at, runtime, session, repo, mode, delivered, advised, noted, fallbacks, answers } = raw;
	if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return undefined;
	if (!RUNTIMES.includes(runtime as Runtime) || typeof session !== "string" || typeof repo !== "string" || typeof mode !== "string") return undefined;
	if (!isRoute(delivered) || (advised !== undefined && !isRoute(advised)) || typeof noted !== "boolean") return undefined;
	if (!Array.isArray(fallbacks) || !fallbacks.every((f) => typeof f === "string")) return undefined;
	if (answers !== undefined && !(isObject(answers) && isAnswer(answers.door) && isAnswer(answers.level) && typeof answers.model === "string")) return undefined;
	return raw as RouteRecord;
}

export type LedgerRead = { root: string; files: number; records: RouteRecord[]; malformed: number; duplicates: number };

/** Every record under root (`<machine>/<runtime>-<session>.jsonl`), deduplicated: copied ledgers can repeat a line. */
export function readLedger(root: string): LedgerRead {
	const read: LedgerRead = { root, files: 0, records: [], malformed: 0, duplicates: 0 };
	if (!existsSync(root)) return read;
	const seen = new Set<string>();
	for (const machine of readdirSync(root, { withFileTypes: true })) {
		if (!machine.isDirectory()) continue;
		for (const file of readdirSync(join(root, machine.name), { withFileTypes: true })) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			read.files++;
			for (const line of readFileSync(join(root, machine.name, file.name), "utf8").split("\n")) {
				if (line.trim() === "") continue;
				const record = parseRecord(line);
				if (record === undefined) {
					read.malformed++;
					continue;
				}
				const key = [record.machine, record.runtime, record.session, record.at, record.digest].join("\u0000");
				if (seen.has(key)) read.duplicates++;
				else (seen.add(key), read.records.push(record));
			}
		}
	}
	return read;
}

export type CorrectionsRead = { dir: string; files: number; sessions: string[]; malformed: number };

/** The session of every correction record in dir (`<session>.json`, each a JSON array). Only the session is kept. */
export function readCorrections(dir: string): CorrectionsRead {
	const read: CorrectionsRead = { dir, files: 0, sessions: [], malformed: 0 };
	if (!existsSync(dir)) return read;
	for (const file of readdirSync(dir, { withFileTypes: true })) {
		if (!file.isFile() || !file.name.endsWith(".json")) continue;
		read.files++;
		let entries: unknown;
		try {
			entries = JSON.parse(readFileSync(join(dir, file.name), "utf8"));
		} catch {
			read.malformed++;
			continue;
		}
		if (!Array.isArray(entries)) {
			read.malformed++;
			continue;
		}
		for (const entry of entries) {
			const session = isObject(entry) && isObject(entry.evidence) ? entry.evidence.session : undefined;
			if (typeof session === "string" && session.length > 0) read.sessions.push(recordText(session, FIELD_MAX.session));
			else read.malformed++;
		}
	}
	return read;
}

/** Whether the advised route carried the note: Jev's answers cleared the note's threshold. */
export function decided(note: NoteId, record: RouteRecord): boolean {
	return record.advised !== undefined && carries(note, record.advised);
}

/** Whether the note reached the agent. */
export function delivered(note: NoteId, record: RouteRecord): boolean {
	return record.noted && carries(note, record.delivered);
}

function carries(note: NoteId, route: Route): boolean {
	if (note === "door") return route.level !== "lookup" && route.door !== undefined;
	return route.level === note;
}

/** The fallbacks that can stop each decided note on its way to the agent. */
const STOPPED_BY: Record<NoteId, readonly Fallback[]> = {
	door: ["explicit-choice", "queued"],
	lookup: ["explicit-choice", "queued", "model-drift"],
	loop: ["explicit-choice", "queued", "model-drift", "skill-missing"],
};

/** Why a decided note was not delivered: a fallback, the session's AGENTIC_ROUTE, or the policy's shadow mode. */
export function withheldReason(note: NoteId, record: RouteRecord): string {
	const fallback = record.fallbacks.find((f) => STOPPED_BY[note].includes(f));
	if (fallback !== undefined) return fallback;
	return record.mode === "shadow" ? "session-shadow" : "policy-shadow";
}

type Counts = Record<string, number>;
const bump = (counts: Counts, key: string, by = 1) => void (counts[key] = (counts[key] ?? 0) + by);

export type RuntimeRow = { runtime: Runtime; prompts: number; classified: number; noted: number; fallbacks: Counts };
export type NoteRow = { note: NoteId; runtime: Runtime; decided: number; delivered: number; withheld: number; reasons: Counts };
export type AnswerRow = { question: "door" | "level"; choice: string; runtime: Runtime; count: number; share: number; medianConfidence: number };
export type CorrectionRow = { group: string; sessions: number; corrected: number; corrections: number };
export type Report = {
	window: { since: string; until: string; days: number };
	ledger: { root: string; files: number; inWindow: number; outsideWindow: number; malformed: number; duplicates: number };
	policies: Counts;
	machines: Counts;
	runtimes: RuntimeRow[];
	notes: NoteRow[];
	answers: AnswerRow[];
	corrections:
		| { kind: "none"; reason: string }
		| { kind: "counted"; dir: string; repo: string; records: number; unmatched: number; malformed: number; rows: CorrectionRow[]; caveat: string };
};

export const CORRELATION_CAVEAT = "Correlation, not causation: a note goes to the prompts Jev rates, and corrections follow the work, not the note.";

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export type ReportInput = {
	ledger: LedgerRead;
	/** The current repository's corrections and its slug as records name it, or why there are none. */
	corrections: { kind: "read"; read: CorrectionsRead; repo: string } | { kind: "none"; reason: string };
	now: number;
	days: number;
};

export function buildReport(input: ReportInput): Report {
	const { ledger, now, days } = input;
	if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`route-report: days must be an integer from 1 to ${MAX_DAYS}, got ${days}`);
	const since = now - days * DAY_MS;
	const window = ledger.records.filter((r) => {
		const at = Date.parse(r.at);
		return at >= since && at <= now;
	});
	const runtimes = RUNTIMES.filter((runtime) => window.some((r) => r.runtime === runtime));
	const policies: Counts = {};
	const machines: Counts = {};
	for (const r of window) bump(policies, r.policy), bump(machines, r.machine);

	const runtimeRows: RuntimeRow[] = runtimes.map((runtime) => {
		const rows = window.filter((r) => r.runtime === runtime);
		const fallbacks: Counts = {};
		for (const r of rows) for (const f of r.fallbacks) bump(fallbacks, f);
		return { runtime, prompts: rows.length, classified: rows.filter((r) => r.answers !== undefined).length, noted: rows.filter((r) => r.noted).length, fallbacks };
	});

	const noteRows: NoteRow[] = NOTES.flatMap((note) =>
		runtimes.map((runtime) => {
			const rows = window.filter((r) => r.runtime === runtime && decided(note, r));
			const reasons: Counts = {};
			let deliveredCount = 0;
			for (const r of rows) {
				if (delivered(note, r)) deliveredCount++;
				else bump(reasons, withheldReason(note, r));
			}
			return { note, runtime, decided: rows.length, delivered: deliveredCount, withheld: rows.length - deliveredCount, reasons };
		}),
	);

	const answerRows: AnswerRow[] = (["door", "level"] as const).flatMap((question) =>
		runtimes.flatMap((runtime) => {
			const answered = window.filter((r) => r.runtime === runtime && r.answers !== undefined).map((r) => r.answers![question]);
			const choices = [...new Set(answered.map((a) => a.choice))].sort();
			return choices.map((choice) => {
				const picked = answered.filter((a) => a.choice === choice);
				return { question, choice, runtime, count: picked.length, share: picked.length / answered.length, medianConfidence: median(picked.map((a) => a.confidence)) };
			});
		}),
	);

	return {
		window: { since: new Date(since).toISOString(), until: new Date(now).toISOString(), days },
		ledger: { root: ledger.root, files: ledger.files, inWindow: window.length, outsideWindow: ledger.records.length - window.length, malformed: ledger.malformed, duplicates: ledger.duplicates },
		policies,
		machines,
		runtimes: runtimeRows,
		notes: noteRows,
		answers: answerRows,
		corrections: correctionSection(input, window),
	};
}

function correctionSection(input: ReportInput, window: RouteRecord[]): Report["corrections"] {
	if (input.corrections.kind === "none") return input.corrections;
	const { read, repo } = input.corrections;
	const perSession = new Map<string, number>();
	for (const session of read.sessions) perSession.set(session, (perSession.get(session) ?? 0) + 1);
	// Corrections are per repository, so only this repository's sessions form the groups.
	const sessions = new Map<string, RouteRecord[]>();
	for (const r of window) if (r.repo === repo) sessions.set(r.session, [...(sessions.get(r.session) ?? []), r]);
	const row = (group: string, keep: (records: RouteRecord[]) => boolean): CorrectionRow => {
		const members = [...sessions].filter(([, records]) => keep(records)).map(([session]) => perSession.get(session) ?? 0);
		return { group, sessions: members.length, corrected: members.filter((n) => n > 0).length, corrections: members.reduce((a, b) => a + b, 0) };
	};
	const anyNote = (records: RouteRecord[]) => NOTES.some((note) => records.some((r) => delivered(note, r)));
	const rows = [
		...NOTES.map((note) => row(`${note} note delivered`, (records) => records.some((r) => delivered(note, r)))),
		row("any note delivered", anyNote),
		row("no note delivered", (records) => !anyNote(records)),
	];
	const unmatched = read.sessions.filter((session) => !sessions.has(session)).length;
	return { kind: "counted", dir: read.dir, repo, records: read.sessions.length, unmatched, malformed: read.malformed, rows, caveat: CORRELATION_CAVEAT };
}

function table(headers: string[], rows: string[][]): string {
	if (rows.length === 0) return "  (none)";
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
	const line = (cells: string[]) => `  ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ")}`.trimEnd();
	return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const listCounts = (counts: Counts) =>
	Object.entries(counts)
		.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
		.map(([key, n]) => `${key} ${n}`)
		.join(", ") || "-";

export function formatReport(report: Report): string {
	const { window, ledger } = report;
	const out = [
		`Task-route report, ${window.since.slice(0, 10)} to ${window.until.slice(0, 10)} (${window.days} ${window.days === 1 ? "day" : "days"})`,
		`Ledger: ${ledger.root}: ${ledger.inWindow} records in the window, ${ledger.outsideWindow} outside, from ${ledger.files} files; ${ledger.malformed} unreadable lines, ${ledger.duplicates} duplicates skipped.`,
		`Policies: ${listCounts(report.policies)}. Machines: ${listCounts(report.machines)}.`,
		"",
		"Prompts",
		table(
			["runtime", "prompts", "classified", "noted", "fallbacks"],
			report.runtimes.map((r) => [r.runtime, String(r.prompts), String(r.classified), String(r.noted), listCounts(r.fallbacks)]),
		),
		"",
		"Notes (decided: Jev's answers cleared the note's threshold; withheld: decided but not delivered)",
		table(
			["note", "runtime", "decided", "delivered", "withheld", "withheld by reason"],
			report.notes.map((r) => [r.note, r.runtime, String(r.decided), String(r.delivered), String(r.withheld), listCounts(r.reasons)]),
		),
		"",
		"Answers",
		table(
			["question", "choice", "runtime", "count", "share", "median confidence"],
			report.answers.map((r) => [r.question, r.choice, r.runtime, String(r.count), `${(r.share * 100).toFixed(0)}%`, r.medianConfidence.toFixed(2)]),
		),
		"",
	];
	const c = report.corrections;
	if (c.kind === "none") out.push(`Corrections: ${c.reason}.`);
	else
		out.push(
			`Corrections in ${c.repo} sessions, from ${c.dir}: ${c.records} records, ${c.unmatched} in sessions without a record in the window, ${c.malformed} unreadable.`,
			table(
				["sessions with", "sessions", "corrected", "corrections"],
				c.rows.map((r) => [r.group, String(r.sessions), String(r.corrected), String(r.corrections)]),
			),
			c.caveat,
		);
	return `${out.join("\n")}\n`;
}
