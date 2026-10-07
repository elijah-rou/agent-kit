// Verdicts for the merge ledger (design D8, decision O10). The only writer is
// `agentic verify record`, run by a fresh verifier: the policy gate denies it to any session that
// pushed the pull request's branch, and denies posting the agentic/verdict status any other way.
// A verdict is bound to the head SHA and the patch ID, so a rebase or new push voids it.

import { PASSING } from "../../src/facts.ts";

export const STATUS_CONTEXT = "agentic/verdict";

export const VERDICTS = ["live-ui-verified", "unit-test-verified", "type-check-only", "verifier-blocked", "verifier-failed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: string): value is Verdict {
	return (VERDICTS as readonly string[]).includes(value);
}

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

export interface LedgerEntry {
	pr: number;
	sha: string;
	verdict: string;
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
