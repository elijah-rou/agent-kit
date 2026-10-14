// PR risk inside the landing modes: a PR whose P(one-way door) is above HIGH_ABOVE gets a second
// audit lane in its verification round. The score never holds a PR, and nothing lands because Jev
// said so. A PR Jev did not score (unavailable, withheld, or a private repository) gets only a note
// in the report. The question, the state layout, the threshold, and JEV_MODEL were calibrated
// together on the 2026-10-07 door samples in a separate evaluation repository: changing any of them
// means recalibrating. Only public repositories are classified.

import { askJev, isProbability, type Unavailable } from "./egress.ts";

/** A PR scoring above this is high risk: 74 of 82 one-way doors scored above it, and 32 of 99 safe PRs. */
export const HIGH_ABOVE = 0.3;

export const PR_RISK_INSTRUCTIONS =
	"The state is a change about to be merged into a software repository's default branch. " +
	"Answer yes if landing it is a one-way door: merging could not be fully undone by reverting the commit, " +
	"or it commits the project to something others depend on. That includes a public contract (an API, CLI flags or output, " +
	"a file or wire format, a config schema others consume), persisted data (schemas, migrations, stored-data formats, " +
	"deleting or rewriting stored data), a security boundary (authentication, authorization, permissions, credentials or secrets, " +
	"sandboxing, CI permissions, branch protection, new dependency sources or install scripts), a release or deploy, " +
	"or hard-to-reverse architecture, core data structures, or the ownership or concurrency model. " +
	"Answer no for internal refactors, documentation, tests, checksum-verified version bumps, styling, " +
	"and other changes a plain revert fully undoes.";

export type Noul = { kind: "ok"; probability: number } | Unavailable;

export async function prRisk(state: string, options: Parameters<typeof askJev>[2]): Promise<Noul> {
	const answer = await askJev({ type: "noul", instructions: PR_RISK_INSTRUCTIONS }, state, options);
	if (answer.kind === "unavailable") return answer as Unavailable;
	return answer.type === "noul" && isProbability(answer.noul) ? { kind: "ok", probability: answer.noul } : { kind: "unavailable", detail: "malformed noul answer" };
}

/** A PR's risk: high (above the threshold), low, or not scored (Jev unavailable, the PR withheld, or a private repository). */
export type Risk = { kind: "high" | "low"; reason: string } | { kind: "not scored"; reason: string };

/** The landing modes add a second audit lane only for high; not scored is only a note in the report. */
export const RISK_EXIT: Readonly<Record<Risk["kind"], number>> = { low: 0, high: 3, "not scored": 4 };

/** The risk Jev's answer gives a PR; an answer that is not a probability leaves it not scored. */
export function prDecision(result: Noul): Risk {
	if (result.kind === "unavailable") return { kind: "not scored", reason: `Jev unavailable (${result.detail})` };
	return result.probability > HIGH_ABOVE
		? { kind: "high", reason: `P(one-way door) ${result.probability.toFixed(2)} > ${HIGH_ABOVE}` }
		: { kind: "low", reason: `P(one-way door) ${result.probability.toFixed(2)} <= ${HIGH_ABOVE}` };
}

/** The classifier state for a PR, in the layout the thresholds were calibrated on. */
export function prState(input: { repo: string; title: string; body: string; stat: string; diff: string }): string {
	const body = input.body.replace(/\r\n/g, "\n").trim();
	const statLines = input.stat.replace(/\n+$/, "").split("\n").filter(Boolean);
	const files = Math.max(0, statLines.length - 1);
	const shown = statLines.length > 40 ? [...statLines.slice(0, 39), statLines.at(-1)!] : statLines;
	const diff = input.diff.length > 6000 ? `${input.diff.slice(0, 6000)}\n[truncated]` : input.diff.replace(/\n+$/, "");
	return [`Repository: ${input.repo}`, `Subject: ${input.title}`, `Body: ${body.slice(0, 600)}`, `Files changed (${files}):`, ...shown, "Diff (truncated to 6000 characters):", diff].join("\n");
}
