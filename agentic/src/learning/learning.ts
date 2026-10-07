/**
 * The learning loop (design D9). Sessions write only their own file under
 * .agents/learning/sessions/. One consolidator, serialized by a lock, merges them:
 *   - enforceable learnings go to the `correct` backlog, never into instructions;
 *   - judgment learnings become candidates; one seen in two or more sessions is ready for
 *     review, and only an explicit user approval promotes it;
 *   - candidates not seen again within the expiry window expire.
 * Global learnings become a proposal file; nothing here edits the pinned agent-kit checkout.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionEntry {
	kind: "repo" | "global";
	text: string;
	evidence: { session: string; date: string };
	enforceable: boolean;
}

export type CandidateStatus = "candidate" | "ready-for-review" | "approved" | "expired";

export interface Candidate {
	id: string;
	kind: "repo" | "global";
	text: string;
	sessions: string[];
	evidence: { session: string; date: string }[];
	firstSeen: string;
	lastSeen: string;
	status: CandidateStatus;
}

export interface BacklogItem {
	text: string;
	kind: "repo" | "global";
	evidence: { session: string; date: string }[];
}

export interface LearningState {
	processed: Record<string, string>;
	candidates: Candidate[];
	backlog: BacklogItem[];
}

export const EXPIRY_DAYS = 30;
export const GRADUATION_SESSIONS = 2;

export function learningDir(repoRoot: string): string {
	return join(repoRoot, ".agents", "learning");
}

function writeAtomic(path: string, contents: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, contents);
	renameSync(temporary, path);
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function idFor(text: string): string {
	return `L-${Bun.hash(normalize(text)).toString(16).slice(0, 10)}`;
}

/** Validates one session file strictly; a malformed file is reported and skipped, never half-read. */
export function parseSessionFile(text: string, file: string): SessionEntry[] {
	const parsed = JSON.parse(text) as unknown;
	if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array`);
	return parsed.map((raw, index) => {
		const entry = raw as Partial<SessionEntry>;
		if (entry.kind !== "repo" && entry.kind !== "global") throw new Error(`${file}[${index}]: kind must be "repo" or "global"`);
		if (typeof entry.text !== "string" || entry.text.trim() === "") throw new Error(`${file}[${index}]: text is required`);
		if (!entry.evidence || typeof entry.evidence.session !== "string" || typeof entry.evidence.date !== "string") throw new Error(`${file}[${index}]: evidence.session and evidence.date are required`);
		if (typeof entry.enforceable !== "boolean") throw new Error(`${file}[${index}]: enforceable must be a boolean`);
		return entry as SessionEntry;
	});
}

/** Writes this session's learnings to its own file. Each session is the only writer of its file. */
export function writeSessionFile(repoRoot: string, sessionId: string, entries: SessionEntry[]): string {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error(`invalid session id ${sessionId}`);
	const dir = join(learningDir(repoRoot), "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.json`);
	writeAtomic(file, `${JSON.stringify(entries, null, 2)}\n`);
	return file;
}

function readState(dir: string): LearningState {
	const file = join(dir, "state.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LearningState) : { processed: {}, candidates: [], backlog: [] };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Exclusive lock for the single consolidator. A lock whose holder process is gone is replaced. */
export function withLock<T>(dir: string, work: () => T): T {
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, "consolidator.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lock, "wx");
			writeFileSync(fd, String(process.pid));
			closeSync(fd);
			try {
				return work();
			} finally {
				rmSync(lock, { force: true });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = Number(readFileSync(lock, "utf8"));
			if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) throw new Error(`consolidator lock held by pid ${holder}`);
			rmSync(lock, { force: true });
		}
	}
	throw new Error("could not acquire the consolidator lock");
}

export interface ConsolidationReport {
	sessionsProcessed: string[];
	malformed: string[];
	newBacklog: number;
	readyForReview: string[];
	expired: string[];
}

export function consolidate(repoRoot: string, now: Date): ConsolidationReport {
	const dir = learningDir(repoRoot);
	return withLock(dir, () => {
		const state = readState(dir);
		const sessionsDir = join(dir, "sessions");
		const report: ConsolidationReport = { sessionsProcessed: [], malformed: [], newBacklog: 0, readyForReview: [], expired: [] };
		const files = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((name) => name.endsWith(".json")).sort() : [];
		for (const name of files) {
			const file = join(sessionsDir, name);
			const stamp = `${statSync(file).mtimeMs}`;
			if (state.processed[name] === stamp) continue;
			let entries: SessionEntry[];
			try {
				entries = parseSessionFile(readFileSync(file, "utf8"), name);
			} catch (error) {
				report.malformed.push((error as Error).message);
				continue;
			}
			for (const entry of entries) {
				if (entry.enforceable) {
					const existing = state.backlog.find((item) => normalize(item.text) === normalize(entry.text));
					if (existing) existing.evidence.push(entry.evidence);
					else {
						state.backlog.push({ text: entry.text, kind: entry.kind, evidence: [entry.evidence] });
						report.newBacklog++;
					}
					continue;
				}
				const id = idFor(entry.text);
				let candidate = state.candidates.find((c) => c.id === id);
				if (!candidate) {
					candidate = { id, kind: entry.kind, text: entry.text, sessions: [], evidence: [], firstSeen: entry.evidence.date, lastSeen: entry.evidence.date, status: "candidate" };
					state.candidates.push(candidate);
				}
				if (!candidate.sessions.includes(entry.evidence.session)) candidate.sessions.push(entry.evidence.session);
				candidate.evidence.push(entry.evidence);
				if (entry.evidence.date > candidate.lastSeen) candidate.lastSeen = entry.evidence.date;
				if (candidate.status === "expired") candidate.status = "candidate";
			}
			state.processed[name] = stamp;
			report.sessionsProcessed.push(name);
		}
		const cutoff = new Date(now.getTime() - EXPIRY_DAYS * 86_400_000).toISOString();
		for (const candidate of state.candidates) {
			if (candidate.status === "approved") continue;
			if (candidate.sessions.length >= GRADUATION_SESSIONS) {
				if (candidate.status !== "ready-for-review") report.readyForReview.push(candidate.id);
				candidate.status = "ready-for-review";
			} else if (candidate.lastSeen < cutoff && candidate.status !== "expired") {
				candidate.status = "expired";
				report.expired.push(candidate.id);
			}
		}
		writeAtomic(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
		render(dir, state);
		return report;
	});
}

/** User approval promotes a ready candidate. Approval is the only path into instructions. */
export function approve(repoRoot: string, id: string): Candidate {
	const dir = learningDir(repoRoot);
	return withLock(dir, () => {
		const state = readState(dir);
		const candidate = state.candidates.find((c) => c.id === id);
		if (!candidate) throw new Error(`no learning ${id}`);
		if (candidate.status !== "ready-for-review") throw new Error(`${id} is ${candidate.status}; only ready-for-review learnings can be approved`);
		candidate.status = "approved";
		writeAtomic(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
		render(dir, state);
		return candidate;
	});
}

function evidenceList(evidence: { session: string; date: string }[]): string {
	return evidence.map((e) => `${e.session} (${e.date})`).join(", ");
}

function render(dir: string, state: LearningState): void {
	const approved = state.candidates.filter((c) => c.status === "approved");
	const repo = approved.filter((c) => c.kind === "repo");
	const global = approved.filter((c) => c.kind === "global");
	writeAtomic(
		join(dir, "LEARNED.md"),
		`# Learned rules for this repository\n\nApproved by the user through the learning loop. Evidence names the sessions each rule came from.\n\n${repo.map((c) => `- ${c.text} (evidence: ${evidenceList(c.evidence)})`).join("\n") || "- none yet"}\n`,
	);
	writeAtomic(
		join(dir, "proposed-global.md"),
		`# Proposed global instruction changes\n\nApproved global learnings, to be proposed as a change to agent-kit. This file never edits the pinned checkout.\n\n${global.map((c) => `- ${c.text} (evidence: ${evidenceList(c.evidence)})`).join("\n") || "- none yet"}\n`,
	);
	writeAtomic(
		join(dir, "backlog.json"),
		`${JSON.stringify(state.backlog, null, 2)}\n`,
	);
}

export interface CadenceState {
	turnsSinceLast: number;
	lastRunAt: string | null;
}

/** Upstream continual-learning cadence: at least 10 turns and 120 minutes since the last run. */
export const CADENCE = { minTurns: 10, minMinutes: 120 };

export function reflectionDue(state: CadenceState, now: Date): boolean {
	if (state.turnsSinceLast < CADENCE.minTurns) return false;
	if (state.lastRunAt === null) return true;
	return now.getTime() - new Date(state.lastRunAt).getTime() >= CADENCE.minMinutes * 60_000;
}
