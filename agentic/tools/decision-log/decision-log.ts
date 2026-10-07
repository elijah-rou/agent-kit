// Append-only TSV decision trail (design L6, D8, slice 6).
//
// File format: UTF-8 text. Line 1 is the header `ts phase decision why evidence result`,
// tab-separated. Every later line is one row of exactly six tab-separated cells and ends in
// "\n". `ts` is an ISO 8601 UTC timestamp as produced by `Date.prototype.toISOString`.
// Cells never contain tabs or newlines, and never start with `=`, `+`, `-` or `@` (a leading
// single quote is added so spreadsheets do not evaluate the cell as a formula).
//
// One writer per log file (L6). Rows are appended with a single `write` on a descriptor
// opened with O_APPEND; the header is created by linking a fully written temp file into
// place, so no reader ever sees a partial header and two first writers cannot both write it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const COLUMNS = ["ts", "phase", "decision", "why", "evidence", "result"] as const;
export const HEADER = COLUMNS.join("\t");
const COLUMN_COUNT = COLUMNS.length;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const FORMULA_LEAD = /^[=+\-@]/;
const ROW_BYTES_MAX = 64 * 1024;

export type Row = Record<(typeof COLUMNS)[number], string>;
export type RowInput = Omit<Row, "ts">;

export interface Problem {
	readonly line: number;
	readonly message: string;
}

export function sanitizeCell(value: string): string {
	const flat = value.replace(/\r\n|[\t\r\n]/g, " ");
	if (FORMULA_LEAD.test(flat)) {
		return `'${flat}`;
	} else {
		return flat;
	}
}

export function formatRow(row: Row): string {
	const cells = COLUMNS.map((column) => sanitizeCell(row[column]));
	assert.equal(cells.length, COLUMN_COUNT);
	const line = `${cells.join("\t")}\n`;
	assert.equal(line.split("\t").length, COLUMN_COUNT);
	return line;
}

export function append(log: string, input: RowInput, now: Date): Row {
	if (input.decision.trim() === "") {
		throw new UsageError("decision must not be empty");
	}
	ensureHeader(log);
	const row: Row = { ts: now.toISOString(), ...input };
	const bytes = Buffer.from(formatRow(row), "utf8");
	if (bytes.length > ROW_BYTES_MAX) {
		throw new UsageError(`row is ${bytes.length} bytes; the limit is ${ROW_BYTES_MAX}`);
	}
	const descriptor = openSync(log, "a");
	try {
		const written = writeSync(descriptor, bytes);
		assert.equal(written, bytes.length, "partial append");
	} finally {
		closeSync(descriptor);
	}
	return row;
}

// Writes a `start` row naming the timestamp range of the rows already present, which this run
// did not write. Readers use it to separate one run's decisions from earlier runs'.
export function start(log: string, runId: string, now: Date): Row {
	if (runId.trim() === "") {
		throw new UsageError("run-id must not be empty");
	}
	const prior = existsSync(log) ? parseLog(readFileSync(log, "utf8")).rows : [];
	const range =
		prior.length === 0
			? "prior rows: none"
			: `prior rows: ${prior.length}, ${prior[0]!.row.ts}..${prior.at(-1)!.row.ts}`;
	return append(
		log,
		{
			phase: "start",
			decision: `start run ${runId}`,
			why: `rows before this one were not written by run ${runId}`,
			evidence: "",
			result: range,
		},
		now,
	);
}

function ensureHeader(log: string): void {
	if (existsSync(log)) {
		const firstLine = readFileSync(log, "utf8").split("\n", 1)[0];
		if (firstLine !== HEADER) {
			throw new LogError(`${log}: line 1 is not the decision-log header`);
		}
		return;
	}
	// Per-run logs live under directories such as .audit/ that may not exist yet (L6).
	mkdirSync(dirname(log), { recursive: true });
	const temp = join(dirname(log), `.${process.pid}.${Date.now()}.decision-log.tmp`);
	writeFileSync(temp, `${HEADER}\n`, { flag: "wx" });
	try {
		linkSync(temp, log);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	} finally {
		unlinkSync(temp);
	}
	assert.ok(statSync(log).size >= HEADER.length + 1);
}

interface ParsedRow {
	readonly line: number;
	readonly row: Row;
}

interface ParsedLog {
	readonly rows: readonly ParsedRow[];
	readonly problems: readonly Problem[];
}

export function parseLog(text: string): ParsedLog {
	const problems: Problem[] = [];
	const rows: ParsedRow[] = [];
	if (text === "") {
		return { rows, problems: [{ line: 1, message: "log is empty; expected a header" }] };
	}
	if (!text.endsWith("\n")) {
		const lastLine = text.split("\n").length;
		problems.push({ line: lastLine, message: "final row is not newline-terminated" });
	}
	const lines = text.replace(/\n$/, "").split("\n");
	if (lines[0] !== HEADER) {
		problems.push({ line: 1, message: `header must be "${COLUMNS.join("<TAB>")}"` });
	}
	for (let index = 1; index < lines.length; index += 1) {
		const parsed = parseRow(lines[index]!, index + 1);
		problems.push(...parsed.problems);
		if (parsed.row !== null) {
			rows.push({ line: index + 1, row: parsed.row });
		}
	}
	return { rows, problems };
}

function parseRow(text: string, line: number): { row: Row | null; problems: Problem[] } {
	const cells = text.split("\t");
	if (cells.length !== COLUMN_COUNT) {
		const message = `expected ${COLUMN_COUNT} cells, found ${cells.length}`;
		return { row: null, problems: [{ line, message }] };
	}
	const row = Object.fromEntries(COLUMNS.map((column, i) => [column, cells[i]!])) as Row;
	const problems: Problem[] = [];
	if (!isIsoTimestamp(row.ts)) {
		problems.push({ line, message: `ts "${row.ts}" is not an ISO 8601 UTC timestamp` });
	}
	if (row.decision.trim() === "") {
		problems.push({ line, message: "decision is empty" });
	}
	for (const column of COLUMNS) {
		if (FORMULA_LEAD.test(row[column])) {
			problems.push({ line, message: `${column} starts with a formula character` });
		}
	}
	return { row, problems };
}

function isIsoTimestamp(value: string): boolean {
	if (ISO_TIMESTAMP.test(value)) {
		return !Number.isNaN(Date.parse(value));
	} else {
		return false;
	}
}

// Checks the schema and that rows only grow: timestamps never decrease. With a snapshot (an
// earlier copy of the same log), also checks that the current log starts with the snapshot
// byte for byte, which proves no earlier row was edited, removed or reordered.
export function validate(text: string, snapshot: string | null): Problem[] {
	const parsed = parseLog(text);
	const problems = [...parsed.problems];
	for (let index = 1; index < parsed.rows.length; index += 1) {
		const previous = parsed.rows[index - 1]!;
		const current = parsed.rows[index]!;
		if (isIsoTimestamp(previous.row.ts) && isIsoTimestamp(current.row.ts)) {
			if (Date.parse(current.row.ts) < Date.parse(previous.row.ts)) {
				const message = `ts goes backwards from line ${previous.line}`;
				problems.push({ line: current.line, message });
			}
		}
	}
	if (snapshot !== null) {
		problems.push(...compareSnapshot(text, snapshot));
	}
	return problems.sort((a, b) => a.line - b.line);
}

function compareSnapshot(text: string, snapshot: string): Problem[] {
	if (text.startsWith(snapshot)) {
		return [];
	}
	const currentLines = text.replace(/\n$/, "").split("\n");
	const snapshotLines = snapshot.replace(/\n$/, "").split("\n");
	for (let index = 0; index < snapshotLines.length; index += 1) {
		const line = index + 1;
		if (index >= currentLines.length) {
			return [{ line, message: "log is shorter than the snapshot; rows were removed" }];
		}
		if (currentLines[index] !== snapshotLines[index]) {
			return [{ line, message: "row differs from the snapshot; the log is not append-only" }];
		}
	}
	const line = snapshotLines.length;
	return [{ line, message: "row from the snapshot lost its newline" }];
}

export type EvidenceKind = "url" | "pr" | "commit" | "file-line" | "file" | "unknown";
export type EvidenceStatus = "ok" | "missing" | "invalid" | "unknown";

export interface EvidenceResult {
	readonly line: number;
	readonly pointer: string;
	readonly kind: EvidenceKind;
	readonly status: EvidenceStatus;
	readonly detail: string;
}

// Evidence cells hold zero or more pointers separated by whitespace or commas. Pointer kinds,
// checked in this order:
//   url        scheme://...      format only (must parse as a URL)
//   pr         pr#123            format only
//   commit     7 to 64 hex chars `git cat-file -e <sha>^{commit}` in the repo
//   file-line  path:line         file exists and has at least `line` lines
//   file       path with a "/" or a file extension, and no ":"; file or directory exists
//   unknown    anything else     reported, never failed
// Relative paths resolve against the repo directory.
export function classifyPointer(pointer: string): EvidenceKind {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pointer)) {
		return "url";
	}
	if (/^pr#/i.test(pointer)) {
		return "pr";
	}
	if (/^[0-9a-f]{7,64}$/i.test(pointer)) {
		return "commit";
	}
	const pathLike = /^(?:[^:]*\/[^:]*|[\w.-]*\.[A-Za-z0-9]+)$/;
	const fileLine = /^(.+):\d+$/.exec(pointer);
	if (fileLine !== null && pathLike.test(fileLine[1]!)) {
		return "file-line";
	}
	if (pathLike.test(pointer)) {
		return "file";
	}
	return "unknown";
}

export function splitPointers(cell: string): string[] {
	const unguarded = cell.replace(/^'(?=[=+\-@])/, "");
	return unguarded.split(/[\s,]+/).filter((pointer) => pointer !== "");
}

export function checkEvidence(text: string, repo: string): EvidenceResult[] {
	const results: EvidenceResult[] = [];
	for (const { line, row } of parseLog(text).rows) {
		for (const pointer of splitPointers(row.evidence)) {
			const kind = classifyPointer(pointer);
			const { status, detail } = resolvePointer(pointer, kind, repo);
			results.push({ line, pointer, kind, status, detail });
		}
	}
	return results;
}

function resolvePointer(
	pointer: string,
	kind: EvidenceKind,
	repo: string,
): { status: EvidenceStatus; detail: string } {
	switch (kind) {
		case "url":
			return URL.canParse(pointer)
				? { status: "ok", detail: "URL format" }
				: { status: "invalid", detail: "does not parse as a URL" };
		case "pr":
			return /^pr#[1-9]\d*$/i.test(pointer)
				? { status: "ok", detail: "PR reference format" }
				: { status: "invalid", detail: "expected pr#<positive number>" };
		case "commit":
			return resolveCommit(pointer, repo);
		case "file-line":
			return resolveFileLine(pointer, repo);
		case "file":
			return existsSync(resolvePath(pointer, repo))
				? { status: "ok", detail: "exists" }
				: { status: "missing", detail: "no such file" };
		case "unknown":
			return { status: "unknown", detail: "unrecognized pointer kind; not checked" };
		default: {
			const impossible: never = kind;
			throw new Error(`unhandled evidence kind ${String(impossible)}`);
		}
	}
}

function resolveCommit(sha: string, repo: string): { status: EvidenceStatus; detail: string } {
	const result = spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`], {
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	return result.status === 0
		? { status: "ok", detail: `commit in ${repo}` }
		: { status: "missing", detail: `no such commit in ${repo}` };
}

function resolveFileLine(pointer: string, repo: string): { status: EvidenceStatus; detail: string } {
	const separator = pointer.lastIndexOf(":");
	assert.ok(separator > 0);
	const path = resolvePath(pointer.slice(0, separator), repo);
	const lineNumber = Number(pointer.slice(separator + 1));
	if (!existsSync(path) || !statSync(path).isFile()) {
		return { status: "missing", detail: "no such file" };
	}
	if (lineNumber < 1) {
		return { status: "invalid", detail: "line numbers start at 1" };
	}
	const lineCount = readFileSync(path, "utf8").replace(/\n$/, "").split("\n").length;
	return lineNumber <= lineCount
		? { status: "ok", detail: `line ${lineNumber} of ${lineCount}` }
		: { status: "missing", detail: `file has ${lineCount} lines` };
}

function resolvePath(path: string, repo: string): string {
	return isAbsolute(path) ? path : resolve(repo, path);
}

export class UsageError extends Error {}
export class LogError extends Error {}
