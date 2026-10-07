// Verdicts for the merge ledger. A fresh verifier that did not write the change records one with
// `agentic verify record`, a local write; the coordinator mirrors it to the forge with
// `agentic verify publish`, so the verifier never publishes. Nothing local stops the author from
// recording: verifier independence rests on the instructions. A verdict covers one head SHA, and
// status and publish also recompute the patch ID and refuse a verdict whose patch changed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STATUS_CONTEXT = "agentic/verdict";

export const VERDICTS = ["live-ui-verified", "unit-test-verified", "type-check-only", "verifier-blocked", "verifier-failed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: string): value is Verdict {
	return (VERDICTS as readonly string[]).includes(value);
}

const PASSING: ReadonlySet<string> = new Set<Verdict>(["live-ui-verified", "unit-test-verified"]);

export function passes(verdict: string): boolean {
	return PASSING.has(verdict);
}

/** The commit status that mirrors a verdict on the forge; a description is capped at 140 characters. */
export function statusFor(verdict: Verdict, patchId: string, evidence: string): { state: "success" | "failure"; description: string; targetUrl?: string } {
	const description = `${verdict}, patch ${patchId.slice(0, 12)}`.slice(0, 140);
	return { state: passes(verdict) ? "success" : "failure", description, ...(/^https:\/\//.test(evidence) ? { targetUrl: evidence } : {}) };
}

/** The ledger's evidence cell: the verifier's evidence plus the patch ID the verdict covers. */
export function evidenceCell(evidence: string, patchId: string): string {
	return `${evidence} patch:${patchId}`;
}

/** Splits an evidence cell back into the evidence and the patch ID. */
export function parseEvidenceCell(cell: string): { evidence: string; patchId: string } {
	const match = /^(.*) patch:([0-9a-f]+)$/.exec(cell);
	if (!match) throw new Error(`ledger evidence has no patch ID: ${cell}`);
	return { evidence: match[1], patchId: match[2] };
}

export interface LedgerEntry {
	pr: number;
	sha: string;
	verdict: string;
	evidence?: string;
}

/** The latest ledger row for a pull request's head, if a verifier recorded one. */
export function rowForHead<T extends LedgerEntry>(ledger: readonly T[], pr: number, headSha: string): T | undefined {
	return [...ledger].reverse().find((row) => row.pr === pr && row.sha === headSha);
}

/** Whether the latest verdict for a pull request covers its current head; anything else is void. */
export function currentVerdict(ledger: readonly LedgerEntry[], pr: number, headSha: string): { state: "pass" | "fail" | "void" | "none"; verdict?: string; sha?: string } {
	const rows = ledger.filter((row) => row.pr === pr);
	const latest = rows.at(-1);
	if (!latest) return { state: "none" };
	const forHead = [...rows].reverse().find((row) => row.sha === headSha);
	if (!forHead) return { state: "void", verdict: latest.verdict, sha: latest.sha };
	return { state: passes(forHead.verdict) ? "pass" : "fail", verdict: forHead.verdict, sha: forHead.sha };
}

/**
 * The repository's orch store, inside git's common directory (`git rev-parse --git-common-dir`):
 * every worktree shares it, and git never tracks it. AGENTIC_ORCH_STORE overrides it.
 */
export function orchStore(gitCommonDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTIC_ORCH_STORE || join(gitCommonDir, "agentic", "orch");
}

const LEDGER_HEADER = "pr\tsha\tverdict\tevidence\tverifier\tts";

/** Reads the orch store's ledger.tsv; a missing ledger has no verdicts. */
export function readLedger(store: string): Required<LedgerEntry>[] {
	const file = join(store, "ledger.tsv");
	if (!existsSync(file)) return [];
	const [header, ...rows] = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
	if (header !== LEDGER_HEADER) throw new Error(`${file}: unexpected ledger header`);
	return rows.map((line) => {
		const [pr, sha, verdict, evidence] = line.split("\t");
		return { pr: Number(pr.replace(/^#/, "")), sha, verdict, evidence };
	});
}

/** owner/name from a GitHub remote URL (https, ssh, or scp form); undefined for anything else. */
export function githubSlug(remote: string): string | undefined {
	const match = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
	return match?.[1];
}
