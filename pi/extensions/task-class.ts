import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { taskHintFor } from "../../agentic/tools/jev/jev.ts";

function isNativeChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_CHILD === "true";
}

// Adds Jev's advisory one-way-door hint (agentic/tools/jev) to the turn's system prompt. Children
// work from briefs, not tasks, so they get none; a failure only means no hint.
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (isNativeChild()) return undefined;
		const hint = await taskHintFor(event.prompt, ctx.cwd).catch(() => undefined);
		return hint ? { systemPrompt: `${event.systemPrompt}\n\n${hint}` } : undefined;
	});
}
