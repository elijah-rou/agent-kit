import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { repoOf } from "../../agentic/tools/jev/egress.ts";
import { appendRecord, routeTask } from "../../agentic/tools/jev/route-task.ts";
import { parseAnswers, POLICY, QUESTIONS, type Classify } from "../../agentic/tools/jev/route.ts";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));
const NOTE_TYPE = "agent-kit/task-route";
/** A note waits this long for its own prompt's turn; past it, the turn belongs to something else. */
export const NOTE_TTL_MS = 10_000;

function isNativeChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "true";
}

/** Jev through Pi's classifier registry, with the TypeSafe credential Pi holds. */
export function registryClassifier(registry: ExtensionContext["modelRegistry"]): Classify {
	return async (state, signal) => {
		const model = registry.findOfType("classifier", "typesafe", "jev-latest");
		if (model === undefined) return { kind: "failed", reason: "classifier-unavailable" };
		const result = await registry.classify(model, { state, questions: QUESTIONS }, { signal });
		if (result.stopReason === "aborted") return { kind: "failed", reason: signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled" };
		if (result.stopReason !== "stop") return { kind: "failed", reason: "error" };
		const answers = parseAnswers(result.model, result.answers);
		return answers ? { kind: "answered", answers } : { kind: "failed", reason: "malformed" };
	};
}

/** Routes and records one input as the user typed it; the note, if any. A failure only means no note. */
async function routeInput(event: InputEvent, ctx: ExtensionContext): Promise<string | undefined> {
	try {
		const origin = isNativeChild() ? "child" : event.source === "extension" ? "extension" : "user";
		const input = { prompt: event.text, cwd: ctx.cwd, runtime: "pi" as const, sessionId: ctx.sessionManager.getSessionId(), origin } as const;
		const deps = { policy: POLICY, classify: registryClassifier(ctx.modelRegistry), repo: repoOf, env: process.env, now: Date.now, skillsDir: SKILLS_DIR, ...(ctx.signal ? { signal: ctx.signal } : {}) };
		const { note, record } = await routeTask(input, deps);
		try {
			appendRecord(record, process.env);
		} catch {
			// A missing record shows in route-report; the note still goes out.
		}
		return note;
	} catch {
		return undefined;
	}
}

// Routes each input with agent-kit's task-route policy (agentic/tools/jev/route.ts) and records it.
// Input arrives before Pi expands skill commands and prompt templates, so only the typed text is
// classified, and a typed command counts as the user's choice. Input queued while the agent works
// gets its note queued the same way; otherwise the next turn's start delivers it. A note is a
// visible custom message, so the system prompt stays byte-stable for the provider cache.
export default function (pi: ExtensionAPI) {
	let pending: { note: string; at: number } | undefined;

	pi.on("input", async (event, ctx) => {
		pending = undefined;
		const note = await routeInput(event, ctx);
		if (note !== undefined) {
			if (event.streamingBehavior) pi.sendMessage({ customType: NOTE_TYPE, content: note, display: true }, { deliverAs: event.streamingBehavior });
			else pending = { note, at: Date.now() };
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", () => {
		const routed = pending;
		pending = undefined;
		if (routed === undefined || Date.now() - routed.at > NOTE_TTL_MS) return undefined;
		return { message: { customType: NOTE_TYPE, content: routed.note, display: true } };
	});
}
