import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { repoOf } from "../../agentic/tools/jev/egress.ts";
import { appendRecord, routeTask } from "../../agentic/tools/jev/route-task.ts";
import { parseAnswers, POLICY, QUESTIONS, type Classify, type Policy } from "../../agentic/tools/jev/route.ts";

const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));
const NOTE_TYPE = "agent-kit/task-route";

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
async function routeInput(event: InputEvent, ctx: ExtensionContext, policy: Policy): Promise<string | undefined> {
	try {
		const origin = isNativeChild() ? "child" : event.source === "extension" ? "extension" : "user";
		const input = { prompt: event.text, cwd: ctx.cwd, runtime: "pi" as const, sessionId: ctx.sessionManager.getSessionId(), origin, queued: event.streamingBehavior !== undefined } as const;
		const deps = { policy, classify: registryClassifier(ctx.modelRegistry), repo: repoOf, env: process.env, now: Date.now, skillsDir: SKILLS_DIR, ...(ctx.signal ? { signal: ctx.signal } : {}) };
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
// classified, and a typed command counts as the user's choice. Every input, command or not,
// replaces the one waiting note, and the next turn takes it only when its prompt is that same text
// (Pi expands only slash commands, which get no note). Only the newest input may fill the slot, so
// a slower, older one cannot overwrite it, and a stale note is always overwritten. A note can only
// reach a turn whose prompt is exactly the text it was computed for; in a race it is dropped. Input
// queued while the agent works is recorded without a note: a queued message would be drained ahead
// of its prompt. A note is a visible custom message, so the system prompt stays byte-stable for
// the provider cache. This assumes no earlier extension transforms input; the only installed input
// handler (pi-unveil) never does. Pi loads the shipped policy; tests pass one with advisory notes,
// since the shipped policy may deliver none.
export function taskRoute(policy: Policy): (pi: ExtensionAPI) => void {
	return (pi) => {
		let latest: { text: string; note: string | undefined } | undefined;
		let inputs = 0;

		pi.on("input", async (event, ctx) => {
			const input = ++inputs;
			latest = undefined;
			const note = await routeInput(event, ctx, policy);
			if (input === inputs) latest = { text: event.text, note };
			return { action: "continue" };
		});

		pi.on("before_agent_start", (event) => {
			const routed = latest;
			latest = undefined;
			if (routed?.note === undefined || routed.text !== event.prompt) return undefined;
			return { message: { customType: NOTE_TYPE, content: routed.note, display: true } };
		});
	};
}

export default taskRoute(POLICY);
