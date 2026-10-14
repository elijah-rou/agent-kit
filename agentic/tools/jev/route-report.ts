// The route report: how each task-route note fared over a window of the local ledger, per runtime,
// and how many corrections the user recorded in sessions that got a note. It counts one policy's
// records at a time and the others only by policy, so shadow-era and trial records never mix. It
// reads its own view of a record, apart from the writer's types, so old ledgers stay readable. It reads only local files
// (the ledger and this repository's correction records) and prints counts, never prompt or
// correction text. readLedger and readCorrections do the I/O; buildReport and formatReport are pure.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIELD_MAX, recordText } from "./route-task.ts";

export const DAY_MS = 86_400_000;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 366;
const NOTES = ["door", "lookup", "loop"] as const;
export type ReportNote = (typeof NOTES)[number];
/**
 * Every runtime a ledger record may name, past ones included. The report reads old ledgers, so this
 * set is its own and only grows: a runtime the writer drops still has records to count.
 */
export const REPORT_RUNTIMES = ["claude", "codex", "pi", "cli"] as const;
export type ReportRuntime = (typeof REPORT_RUNTIMES)[number];

export type ReportRoute = { level: "lookup" | "rigor" | "loop"; door?: { choice: string } };
export type ReportAnswer = { choice: string; confidence: number };
/** The fields of a ledger record the report reads, as it reads them; it never needs the writer's types. */
export type LedgerRecord = {
	policy: string;
	at: string;
	machine: string;
	runtime: ReportRuntime;
	session: string;
	repo: string;
	mode: string;
	digest: string;
	answers?: { door: ReportAnswer; level: ReportAnswer; model: string };
	advised?: ReportRoute;
	delivered: ReportRoute;
	noted: boolean;
	fallbacks: string[];
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isLevel = (v: unknown): v is ReportRoute["level"] => v === "lookup" || v === "rigor" || v === "loop";
const isRuntime = (v: unknown): v is ReportRuntime => REPORT_RUNTIMES.includes(v as ReportRuntime);

function route(v: unknown): ReportRoute | undefined {
	if (!isObject(v) || !isLevel(v.level)) return undefined;
	if (v.door === undefined) return { level: v.level };
	return isObject(v.door) && typeof v.door.choice === "string" ? { level: v.level, door: { choice: v.door.choice } } : undefined;
}

function answer(v: unknown): ReportAnswer | undefined {
	return isObject(v) && typeof v.choice === "string" && typeof v.confidence === "number" && Number.isFinite(v.confidence) ? { choice: v.choice, confidence: v.confidence } : undefined;
}

/** One ledger line as a record, or undefined for a line this reader does not understand, which the report counts as unreadable. */
export function parseRecord(line: string): LedgerRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isObject(raw) || raw.v !== 1) return undefined;
	const { policy, at, machine, runtime, session, repo, mode, digest, noted, fallbacks } = raw;
	if (!isText(policy) || !isText(machine) || !isText(digest) || !isText(at) || !Number.isFinite(Date.parse(at))) return undefined;
	if (!isRuntime(runtime) || typeof session !== "string" || typeof repo !== "string" || typeof mode !== "string" || typeof noted !== "boolean") return undefined;
	if (!Array.isArray(fallbacks) || !fallbacks.every((f) => typeof f === "string")) return undefined;
	const delivered = route(raw.delivered);
	const advised = raw.advised === undefined ? undefined : route(raw.advised);
	if (delivered === undefined || (raw.advised !== undefined && advised === undefined)) return undefined;
	let answers: LedgerRecord["answers"];
	if (raw.answers !== undefined) {
		if (!isObject(raw.answers) || typeof raw.answers.model !== "string") return undefined;
		const door = answer(raw.answers.door);
		const level = answer(raw.answers.level);
		if (door === undefined || level === undefined) return undefined;
		answers = { door, level, model: raw.answers.model };
	}
	return {
		policy,
		at,
		machine,
		runtime,
		session,
		repo,
		mode,
		digest,
		...(answers ? { answers } : {}),
		...(advised ? { advised } : {}),
		delivered,
		noted,
		fallbacks: [...fallbacks],
	};
}

export type LedgerRead = { root: string; files: number; records: LedgerRecord[]; malformed: number; duplicates: number };

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
export function decided(note: ReportNote, record: LedgerRecord): boolean {
	return record.advised !== undefined && carries(note, record.advised);
}

/**
 * Whether the note was written for the agent. Claude Code adds it to the prompt's own turn, as Codex
 * did for its older records; Pi holds it for the next turn and drops it when that turn's prompt is not
 * the routed text, so for Pi this is an upper bound on the notes that reached a turn.
 */
export function noted(note: ReportNote, record: LedgerRecord): boolean {
	return record.noted && carries(note, record.delivered);
}

function carries(note: ReportNote, route: ReportRoute): boolean {
	if (note === "door") return route.level !== "lookup" && route.door !== undefined;
	return route.level === note;
}

/** decide's own fallbacks: they change the advised route itself, so they never explain why a decided note was withheld. */
const DECISION_FALLBACKS: ReadonlySet<string> = new Set(["conflict", "low-confidence"]);

/**
 * Why a decided note was not written: the record's other fallbacks, else the session's
 * AGENTIC_ROUTE=shadow, else unknown. A policy that keeps a note in shadow leaves no fallback, so
 * read an unknown reason against the policy the record names.
 */
export function withheldReason(record: LedgerRecord): string {
	const stops = record.fallbacks.filter((f) => !DECISION_FALLBACKS.has(f));
	if (stops.length > 0) return stops.join("+");
	return record.mode === "shadow" ? "session-shadow" : "unknown";
}

type Counts = Record<string, number>;
const bump = (counts: Counts, key: string, by = 1) => void (counts[key] = (counts[key] ?? 0) + by);

export type RuntimeRow = { runtime: ReportRuntime; prompts: number; classified: number; noted: number; fallbacks: Counts };
export type NoteRow = { note: ReportNote; runtime: ReportRuntime; decided: number; noted: number; withheld: number; reasons: Counts };
export type AnswerRow = { question: "door" | "level"; choice: string; runtime: ReportRuntime; count: number; share: number; medianConfidence: number };
export type CorrectionRow = { group: string; sessions: number; corrected: number; corrections: number };
export type Report = {
	window: { since: string; until: string; days: number };
	ledger: { root: string; files: number; inWindow: number; outsideWindow: number; malformed: number; duplicates: number };
	/** The tables count only the shown policy's records; the window's other records are counted by policy here. */
	policy: { shown: string; records: number; others: Counts };
	machines: Counts;
	runtimes: RuntimeRow[];
	notes: NoteRow[];
	answers: AnswerRow[];
	corrections:
		| { kind: "none"; reason: string }
		| { kind: "counted"; dir: string; repo: string; records: number; unmatched: number; malformed: number; rows: CorrectionRow[]; caveat: string };
};

export const CORRELATION_CAVEAT = "Correlation, not causation: a note goes to the prompts Jev rates, and corrections follow the work, not the note.";
export const PI_NOTED_CAVEAT = "noted: a note was written for the agent. Pi holds it for the next turn and drops it if that turn's prompt is not the routed text, so for pi it is an upper bound.";

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
	/** The policy whose records the tables count, such as task-route@2. */
	policy: string;
};

export function buildReport(input: ReportInput): Report {
	const { ledger, now, days, policy } = input;
	if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`route-report: days must be an integer from 1 to ${MAX_DAYS}, got ${days}`);
	const since = now - days * DAY_MS;
	const inWindow = ledger.records.filter((r) => {
		const at = Date.parse(r.at);
		return at >= since && at <= now;
	});
	// Policies route differently (task-route@1 kept every note in shadow), so one policy's records never mix with another's.
	const window = inWindow.filter((r) => r.policy === policy);
	const others: Counts = {};
	for (const r of inWindow) if (r.policy !== policy) bump(others, r.policy);
	const machines: Counts = {};
	for (const r of window) bump(machines, r.machine);
	const runtimes = REPORT_RUNTIMES.filter((runtime) => window.some((r) => r.runtime === runtime));

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
			let notedCount = 0;
			for (const r of rows) {
				if (noted(note, r)) notedCount++;
				else bump(reasons, withheldReason(r));
			}
			return { note, runtime, decided: rows.length, noted: notedCount, withheld: rows.length - notedCount, reasons };
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
		ledger: { root: ledger.root, files: ledger.files, inWindow: inWindow.length, outsideWindow: ledger.records.length - inWindow.length, malformed: ledger.malformed, duplicates: ledger.duplicates },
		policy: { shown: policy, records: window.length, others },
		machines,
		runtimes: runtimeRows,
		notes: noteRows,
		answers: answerRows,
		corrections: correctionSection(input, window),
	};
}

/** window holds only the shown policy's records, so a session counts only the notes that policy wrote. */
function correctionSection(input: ReportInput, window: LedgerRecord[]): Report["corrections"] {
	if (input.corrections.kind === "none") return input.corrections;
	const { read, repo } = input.corrections;
	const perSession = new Map<string, number>();
	for (const session of read.sessions) perSession.set(session, (perSession.get(session) ?? 0) + 1);
	// Corrections are per repository, so only this repository's sessions form the groups.
	const sessions = new Map<string, LedgerRecord[]>();
	for (const r of window) if (r.repo === repo) sessions.set(r.session, [...(sessions.get(r.session) ?? []), r]);
	const row = (group: string, keep: (records: LedgerRecord[]) => boolean): CorrectionRow => {
		const members = [...sessions].filter(([, records]) => keep(records)).map(([session]) => perSession.get(session) ?? 0);
		return { group, sessions: members.length, corrected: members.filter((n) => n > 0).length, corrections: members.reduce((a, b) => a + b, 0) };
	};
	const anyNote = (records: LedgerRecord[]) => NOTES.some((note) => records.some((r) => noted(note, r)));
	const rows = [
		...NOTES.map((note) => row(`a ${note} note`, (records) => records.some((r) => noted(note, r)))),
		row("any note", anyNote),
		row("no note", (records) => !anyNote(records)),
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
	const { window, ledger, policy } = report;
	const others = Object.keys(policy.others).length === 0 ? "none" : `${listCounts(policy.others)} (not counted below; --policy <id> shows one)`;
	const out = [
		`Task-route report, ${window.since.slice(0, 10)} to ${window.until.slice(0, 10)} (${window.days} ${window.days === 1 ? "day" : "days"})`,
		`Ledger: ${ledger.root}: ${ledger.inWindow} records in the window, ${ledger.outsideWindow} outside, from ${ledger.files} files; ${ledger.malformed} unreadable lines, ${ledger.duplicates} duplicates skipped.`,
		`Policy: ${policy.shown}, ${policy.records} records in the window. Records of other policies: ${others}.`,
		`Machines: ${listCounts(report.machines)}.`,
		"",
		"Prompts",
		table(
			["runtime", "prompts", "classified", "noted", "fallbacks"],
			report.runtimes.map((r) => [r.runtime, String(r.prompts), String(r.classified), String(r.noted), listCounts(r.fallbacks)]),
		),
		"",
		"Notes (decided: Jev's answers cleared the note's threshold; withheld: decided but not noted)",
		table(
			["note", "runtime", "decided", "noted", "withheld", "withheld by reason"],
			report.notes.map((r) => [r.note, r.runtime, String(r.decided), String(r.noted), String(r.withheld), listCounts(r.reasons)]),
		),
		PI_NOTED_CAVEAT,
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
			`Corrections in this repository's sessions (recorded as ${c.repo}), from ${c.dir}: ${c.records} records, ${c.unmatched} in sessions without a ${policy.shown} record in the window, ${c.malformed} unreadable.`,
			table(
				["sessions with", "sessions", "corrected", "corrections"],
				c.rows.map((r) => [r.group, String(r.sessions), String(r.corrected), String(r.corrections)]),
			),
			c.caveat,
		);
	return `${out.join("\n")}\n`;
}
