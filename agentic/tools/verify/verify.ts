// Verdicts for the merge ledger. A fresh verifier that did not write the change records one with
// `agentic verify record`, a local write. The ledger is the merge gate: every merging mode runs
// `agentic verify status` right before each merge and merges only on exit 0 for the head it merges.
// Nothing posts the verdict to the forge. Nothing local stops the author from recording: verifier
// independence rests on the instructions. A verdict covers one head SHA, and status recomputes the
// patch ID (whitespace included) and refuses a verdict whose patch changed. A pull request that touches
// a policy path takes no passing verdict but a countersign.

import { spawnSync } from "node:child_process";
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

/**
 * The one definition of a verification-policy change: a pull request whose diff touches one of these
 * paths sets the policy its own verdict rests on, so `record` refuses every passing verdict for it but
 * `countersigned`. A path ending in `/` covers that name and everything below it; `*` matches within
 * one path segment; matching ignores case, since a case-insensitive checkout folds names together.
 * A verification skill's verdict rules are its `SKILL.md` (verdicts) and `features/README.md` (proof
 * and skip rules); its feature files and drive scripts land on ordinary verdicts, since trunk's copy
 * of the skill decides each verdict. The skill's directory and its `features` name appear in a diff
 * only as a file git tracks there, such as a symlink, which would swap in other verdict rules.
 */
export const POLICY_PATHS = [
	".agents/skills/verify-*/SKILL.md",
	".agents/skills/verify-*/features/README.md",
	".agents/skills/verify-*",
	".agents/skills/verify-*/features",
	"skills/babysit-and-ship/SKILL.md",
	"skills/babysit-and-ship/references/",
	"claude/agents/autopilot-owner.md",
	"agentic/tools/verify/",
	"agentic/vendor/orch/",
	"agentic/bin/agentic",
] as const;

const POLICY_PATTERNS = POLICY_PATHS.map((path) => {
	const body = path.replace(/\/$/, "").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
	return new RegExp(`^${body}${path.endsWith("/") ? "(?:/|$)" : "$"}`, "i");
});

/** The paths among `paths` that are policy paths. */
export function policyFiles(paths: readonly string[]): string[] {
	return paths.filter((path) => POLICY_PATTERNS.some((pattern) => pattern.test(path)));
}

/** Why `record` refuses this verdict for a pull request whose diff touches `touched` policy files, if it does. */
export function policyRefusal(verdict: string, touched: readonly string[]): string | undefined {
	if (!passes(verdict) || verdict === "countersigned" || touched.length === 0) return undefined;
	const named = touched.slice(0, 3).join(", ") + (touched.length > 3 ? `, and ${touched.length - 3} more` : "");
	return `the pull request changes the verification policy (${named}), so ${verdict} is refused: record verifier-blocked, and once the user approves the patch in their own words the coordinator records countersigned with --patch (babysit-and-ship's Countersign rule; the policy paths are in agentic verify --help)`;
}

/** Unquotes a path as git writes it in a diff header: C-style quoting when the name has special characters. */
function diffPath(text: string): string {
	const trimmed = text.replace(/\t$/, "");
	if (!trimmed.startsWith('"')) return trimmed;
	const match = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
	if (!match) throw new Error(`cannot read the quoted diff path ${text}`);
	const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
	const bytes: number[] = [];
	for (let i = 0; i < match[1].length; i++) {
		const char = match[1][i];
		if (char !== "\\") {
			bytes.push(...Buffer.from(char, "utf8"));
			continue;
		}
		const octal = /^[0-7]{3}/.exec(match[1].slice(i + 1));
		const escape = match[1][i + 1];
		if (octal) bytes.push(parseInt(octal[0], 8)), (i += 3);
		else if (escape in simple) bytes.push(simple[escape]), (i += 1);
		else throw new Error(`cannot read the quoted diff path ${text}`);
	}
	return Buffer.from(bytes).toString("utf8");
}

/**
 * Every path a git diff touches, old and new names alike, so a rename out of a policy directory still
 * counts as touching it. Read from each file's header lines only, never from hunk content; a header
 * that names no path it can read is an error, so the policy check fails closed.
 */
export function changedPaths(diff: string): string[] {
	const paths = new Set<string>();
	let header: string | undefined;
	let found: string[] = [];
	const finish = () => {
		if (header === undefined) return;
		if (found.length === 0) {
			// Only a header with the same name on both sides (a mode change, a binary or empty file) names no path elsewhere.
			const rest = header.slice("diff --git ".length);
			const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
			const [a, b] = quoted ? [diffPath(quoted[1]), diffPath(quoted[2])] : [rest.slice(0, (rest.length - 1) / 2), rest.slice((rest.length + 1) / 2)];
			if (!a.startsWith("a/") || b !== `b/${a.slice(2)}`) throw new Error(`cannot read the changed path from the diff header: ${header}`);
			found.push(a.slice(2));
		}
		for (const path of found) paths.add(path);
		header = undefined;
		found = [];
	};
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			finish();
			header = line;
			continue;
		}
		if (header === undefined) continue;
		if (line.startsWith("@@")) {
			finish();
			continue;
		}
		const named = /^(?:rename from|rename to|copy from|copy to) (.+)$/.exec(line);
		if (named) found.push(diffPath(named[1]));
		const side = /^(?:---|\+\+\+) (.+)$/.exec(line);
		if (side && side[1] !== "/dev/null") {
			const path = diffPath(side[1]);
			if (!/^[ab]\//.test(path)) throw new Error(`cannot read the changed path from the diff line: ${line}`);
			found.push(path.slice(2));
		}
	}
	finish();
	return [...paths];
}

/**
 * The patch ID a verdict is bound to. `--verbatim` keeps whitespace: `--stable` ignores it, so a
 * re-indented line or `rm -rf / tmp` for `rm -rf /tmp` would keep a verdict's patch ID.
 */
export function patchIdOf(diff: string): string {
	const result = spawnSync("git", ["patch-id", "--verbatim"], { input: diff, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git patch-id: ${result.stderr.trim()}`);
	const id = result.stdout.split(" ")[0]?.trim();
	if (!id) throw new Error("the pull request has no diff to bind a verdict to");
	return id;
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
	verifier?: string;
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

/** The row that decides a countersign: the head's own row, or after a rebase that kept the patch, the latest row for that patch. */
function countersignDecider(ledger: readonly Required<LedgerEntry>[], pr: number, headSha: string, patchId: string): Required<LedgerEntry> | undefined {
	const head = rowForHead(ledger, pr, headSha);
	return head ?? [...ledger].reverse().find((row) => row.pr === pr && parseEvidenceCell(row.evidence).patchId === patchId);
}

/**
 * Whether the coordinator may record `countersigned` for this head and patch: a fresh verifier must
 * already have recorded `verifier-blocked` for the same patch, so a countersign never stands in for
 * a verification that did not run or that failed. The head's own row decides when there is one;
 * after a rebase that kept the patch, the latest row for the same patch decides, so a countersign
 * can be carried to the new head.
 */
export function countersignable(ledger: readonly Required<LedgerEntry>[], pr: number, headSha: string, patchId: string): boolean {
	const decider = countersignDecider(ledger, pr, headSha, patchId);
	return decider !== undefined && parseEvidenceCell(decider.evidence).patchId === patchId && COUNTERSIGNABLE.has(decider.verdict);
}

const BLOCKED_MARK = " | verifier-blocked by ";

/**
 * The evidence a countersign records, or why it is refused. The user approved one patch, named by its
 * patch ID; a countersign for any other patch needs new words from the user. orch keeps one row per
 * pull request and head, so the countersign replaces the head's verifier-blocked row: its evidence
 * carries that row's verifier ID and evidence, and a carried countersign copies them forward.
 */
export function countersignEvidence(ledger: readonly Required<LedgerEntry>[], pr: number, headSha: string, patchId: string, approvedPatch: string | undefined, evidence: string): { ok: true; evidence: string } | { ok: false; reason: string } {
	if (!countersignable(ledger, pr, headSha, patchId)) return { ok: false, reason: `no verifier-blocked verdict covers patch ${patchId.slice(0, 12)}; a countersign records the user's approval of a fresh verifier's blocked verdict, never a replacement for one` };
	if (approvedPatch === undefined) return { ok: false, reason: `a countersign names the patch the user approved: pass --patch <patch ID> (the current patch is ${patchId})` };
	if (approvedPatch !== patchId) return { ok: false, reason: `the user approved patch ${approvedPatch}, but the pull request's patch is now ${patchId}; a changed patch needs new words from the user` };
	if (evidence.includes(BLOCKED_MARK.trim())) return { ok: false, reason: `the countersign's evidence must not contain "${BLOCKED_MARK.trim()}"; the blocked verdict is added to it` };
	const decider = countersignDecider(ledger, pr, headSha, patchId)!;
	const decided = parseEvidenceCell(decider.evidence).evidence;
	const blocked = decider.verdict === "verifier-blocked" ? `${BLOCKED_MARK}${decider.verifier}: ${decided}` : decided.slice(decided.indexOf(BLOCKED_MARK));
	if (!blocked.startsWith(BLOCKED_MARK)) throw new Error(`countersigned row for ${decider.sha} carries no verifier-blocked evidence: ${decider.evidence}`);
	return { ok: true, evidence: `${evidence}${blocked}` };
}

/** The verifier ID and evidence of the verifier-blocked verdict a countersign's evidence carries. */
export function blockedBy(countersignEvidenceText: string): { verifier: string; evidence: string } | undefined {
	const at = countersignEvidenceText.indexOf(BLOCKED_MARK);
	if (at === -1) return undefined;
	const rest = countersignEvidenceText.slice(at + BLOCKED_MARK.length);
	const colon = rest.indexOf(": ");
	return colon === -1 ? undefined : { verifier: rest.slice(0, colon), evidence: rest.slice(colon + 2) };
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
		const [pr, sha, verdict, evidence, verifier] = line.split("\t");
		return { pr: Number(pr.replace(/^#/, "")), sha, verdict, evidence, verifier };
	});
}

/** owner/name from a GitHub remote URL (https, ssh, or scp form); undefined for anything else. */
export function githubSlug(remote: string): string | undefined {
	const match = /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
	return match?.[1];
}
