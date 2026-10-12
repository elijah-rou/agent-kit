import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { repoOf } from "../../agentic/tools/jev/egress.ts";
import { appendRecord, routeTask } from "../../agentic/tools/jev/route-task.ts";
import { parseAnswers, POLICY, QUESTIONS, type Classify } from "../../agentic/tools/jev/route.ts";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));
const NOTE_TYPE = "agent-kit/task-route";
/** Notes waiting for their prompt's turn; an input handled before reaching the agent leaves one behind. */
const PENDING_MAX = 16;

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
		const input = { prompt: event.text, cwd: ctx.cwd, runtime: "pi" as const, sessionId: ctx.sessionManager.getSessionId(), origin, queued: event.streamingBehavior !== undefined } as const;
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
// classified, and a typed command counts as the user's choice. A note waits for the turn whose
// prompt is that same text (Pi expands only slash commands, which get no note), so it reaches its
// own prompt's turn and no other. Input queued while the agent works is recorded without a note: a
// queued message would be drained ahead of its prompt. A note is a visible custom message, so the
// system prompt stays byte-stable for the provider cache. This assumes no earlier extension
// transforms input; the only installed input handler (pi-unveil) never does.
export default function (pi: ExtensionAPI) {
	const pending = new Map<string, string>();

	pi.on("input", async (event, ctx) => {
		const note = await routeInput(event, ctx);
		if (note !== undefined) {
			pending.delete(event.text);
			pending.set(event.text, note);
			for (const oldest of pending.keys()) {
				if (pending.size <= PENDING_MAX) break;
				pending.delete(oldest);
			}
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		const note = pending.get(event.prompt);
		if (note === undefined) return undefined;
		pending.delete(event.prompt);
		return { message: { customType: NOTE_TYPE, content: note, display: true } };
	});
}
