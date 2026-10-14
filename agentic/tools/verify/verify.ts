// Verdicts for the merge ledger. A fresh verifier that did not write the change records one with
// `agentic verify record`, a local write. The ledger is the merge gate: every merging mode runs
// `agentic verify status` right before each merge and merges only on exit 0 for the head it merges.
// Nothing posts the verdict to the forge. Nothing local stops the author from recording: verifier
// independence rests on the instructions. A verdict covers one head SHA, and status recomputes the
// patch ID and refuses a verdict whose patch changed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VERDICTS = ["live-ui-verified", "unit-test-verified", "countersigned", "type-check-only", "verifier-blocked", "verifier-failed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: string): value is Verdict {
	return (VERDICTS as readonly string[]).includes(value);
}

const PASSING: ReadonlySet<string> = new Set<Verdict>(["live-ui-verified", "unit-test-verified", "countersigned"]);

export function passes(verdict: string): boolean {
	return PASSING.has(verdict);
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

export interface Gate {
	/** pass only when a passing verdict covers the head and its patch is unchanged; a merge needs pass. */
	state: "pass" | "fail" | "void" | "none";
	verdict?: string;
	sha?: string;
	patchChanged: boolean;
}

/**
 * The local merge gate: the verdict for the head decides, and a patch that changed since the verdict
 * voids it. The current patch ID is computed only when a row covers the head, since it needs the diff.
 */
export function gate(ledger: readonly Required<LedgerEntry>[], pr: number, headSha: string, currentPatch: () => string): Gate {
	const verdict = currentVerdict(ledger, pr, headSha);
	const row = rowForHead(ledger, pr, headSha);
	if (!row) return { ...verdict, patchChanged: false };
	const patchChanged = parseEvidenceCell(row.evidence).patchId !== currentPatch();
	return patchChanged ? { state: "void", verdict: verdict.verdict, sha: verdict.sha, patchChanged } : { ...verdict, patchChanged };
}

const COUNTERSIGNABLE: ReadonlySet<string> = new Set<Verdict>(["verifier-blocked", "countersigned"]);

/**
 * Whether the coordinator may record `countersigned` for this head and patch: a fresh verifier must
 * already have recorded `verifier-blocked` for the same patch, so a countersign never stands in for
 * a verification that did not run or that failed. The head's own row decides when there is one;
 * after a rebase that kept the patch, the latest row for the same patch decides, so a countersign
 * can be carried to the new head.
 */
export function countersignable(ledger: readonly Required<LedgerEntry>[], pr: number, headSha: string, patchId: string): boolean {
	const head = rowForHead(ledger, pr, headSha);
	const samePatch = [...ledger].reverse().find((row) => row.pr === pr && parseEvidenceCell(row.evidence).patchId === patchId);
	const decider = head ?? samePatch;
	return decider !== undefined && parseEvidenceCell(decider.evidence).patchId === patchId && COUNTERSIGNABLE.has(decider.verdict);
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
