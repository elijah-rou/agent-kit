/**
 * Checks the interaction contract at the end of each run, and reminds the user when a reflection
 * is due. Both only notify; neither blocks.
 *
 * - Report lint: a run that used tools and ends in a substantial report must open with a "Needs
 *   you" part, and each question in it must carry options, a recommendation, and a default
 *   (agentic report-lint).
 * - Reflection cadence: after at least 10 turns and 120 minutes since the last reminder, suggest
 *   the reflect skill. Nothing here writes learnings.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reflectionDue, type CadenceState } from "../../agentic/src/learning/learning.ts";
import { lintReport } from "../../agentic/tools/report-lint/report-lint.ts";

const CADENCE_ENTRY = "agentic-cadence";
// Shorter replies are conversation, not reports, and need no "Needs you" part.
const REPORT_MIN_CHARS = 400;

type Message = { role?: string; content?: unknown };

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => ((block as { type?: string }).type === "text" ? [(block as { text: string }).text] : [])).join("\n");
}

/** The final report of a run that used tools, or undefined for a conversational turn. */
export function finalReport(messages: readonly Message[]): string | undefined {
	if (!messages.some((message) => message.role === "toolResult")) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "assistant") continue;
		const report = text(messages[i].content).trim();
		return report.length >= REPORT_MIN_CHARS ? report : undefined;
	}
	return undefined;
}

export default function reportContract(pi: ExtensionAPI): void {
	let cadence: CadenceState = { turnsSinceLast: 0, lastRunAt: null };

	pi.on("session_start", (_event, ctx) => {
		cadence = { turnsSinceLast: 0, lastRunAt: null };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CADENCE_ENTRY) cadence = entry.data as CadenceState;
		}
	});

	pi.on("turn_end", () => {
		cadence = { ...cadence, turnsSinceLast: cadence.turnsSinceLast + 1 };
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI || process.env.PI_SUBAGENT_CHILD === "1") return;
		const report = finalReport(event.messages as Message[]);
		const problems = report ? lintReport(report) : [];
		if (problems.length > 0) ctx.ui.notify(`Report does not follow the interaction contract: ${problems.map((problem) => problem.message).join("; ")}`, "warning");
		if (reflectionDue(cadence, new Date())) {
			ctx.ui.notify("A reflection is due: run the reflect skill to capture learnings (you approve each one).", "info");
			cadence = { turnsSinceLast: 0, lastRunAt: new Date().toISOString() };
		}
		pi.appendEntry(CADENCE_ENTRY, cadence);
	});
}
