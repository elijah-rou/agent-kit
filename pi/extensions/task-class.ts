import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { repoOf } from "../../agentic/tools/jev/egress.ts";
import { appendRecord, routeTask } from "../../agentic/tools/jev/route-task.ts";
import { parseAnswers, POLICY, QUESTIONS, type Classify } from "../../agentic/tools/jev/route.ts";

const BACKGROUND_RUN_SKILL = fileURLToPath(new URL("../../skills/background-run/SKILL.md", import.meta.url));
// Pi's own expansion of `/skill:name args`, as agent-session's parseSkillBlock reads it back.
const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

function isNativeChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "true";
}

/** What the user typed: an expanded skill command reads as `/skill:name args` again. */
export function typedPrompt(prompt: string): string {
	const skill = SKILL_BLOCK.exec(prompt);
	return skill ? `/skill:${skill[1]} ${skill[2] ?? ""}`.trim() : prompt;
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

// Routes each prompt with agent-kit's task-route policy (agentic/tools/jev/route.ts) and records it.
// A note arrives as a visible custom message, so the system prompt stays byte-stable for the
// provider cache. Children work from briefs: they are recorded but never classified. A failure
// only means no note.
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const input = { prompt: typedPrompt(event.prompt), cwd: ctx.cwd, runtime: "pi" as const, sessionId: ctx.sessionManager.getSessionId(), child: isNativeChild() };
			const deps = { policy: POLICY, classify: registryClassifier(ctx.modelRegistry), repo: repoOf, env: process.env, now: Date.now, backgroundRunSkill: BACKGROUND_RUN_SKILL, ...(ctx.signal ? { signal: ctx.signal } : {}) };
			const { note, record } = await routeTask(input, deps);
			try {
				appendRecord(record, process.env);
			} catch {
				// A missing record shows in route-report; the note still goes out.
			}
			return note ? { message: { customType: "agent-kit/task-route", content: note, display: true } } : undefined;
		} catch {
			return undefined;
		}
	});
}
