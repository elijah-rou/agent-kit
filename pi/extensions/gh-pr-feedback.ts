import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { collectPrFeedback, DEFAULT_LIMIT, MAX_LIMIT, processRunner, renderText } from "../../agentic/tools/pr-feedback/pr-feedback.ts";

interface Params {
	number?: number;
	repo?: string;
	includeResolved?: boolean;
	includeOutdated?: boolean;
	includeAnnotations?: boolean;
	limit?: number;
}

// Pi's adapter for the shared collector in agentic/tools/pr-feedback, which `agentic pr-feedback` also runs.
export default function ghPrFeedbackExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "gh_pr_feedback",
		label: "GitHub PR Feedback",
		description: "Read GitHub PR human review comments, unresolved threads, CI/check state, and check annotations, then summarize what must be actioned locally. Read-only.",
		promptSnippet: "Read current GitHub PR review/CI feedback as local action items",
		promptGuidelines: [
			"Use gh_pr_feedback when the user asks to act on PR reviews, comments, failing checks, or the current PR state.",
			"gh_pr_feedback is read-only; do not use it to reply, resolve threads, approve, request changes, merge, or push.",
		],
		parameters: Type.Object({
			number: Type.Optional(Type.Number({ description: "PR number. Defaults to the PR for the current branch." })),
			repo: Type.Optional(Type.String({ description: "GitHub repo as owner/name. Defaults to current repo." })),
			includeResolved: Type.Optional(Type.Boolean({ description: "Include resolved review threads. Defaults false." })),
			includeOutdated: Type.Optional(Type.Boolean({ description: "Include outdated review threads. Defaults false." })),
			includeAnnotations: Type.Optional(Type.Boolean({ description: "Fetch check annotations. Defaults true." })),
			limit: Type.Optional(Type.Number({ description: "Maximum comments/threads/checks/annotations per section. Defaults 80." })),
		}),
		async execute(_id, params: Params, _signal, _onUpdate, ctx) {
			const requested = typeof params.number === "number" && Number.isFinite(params.number) ? Math.trunc(params.number) : 0;
			if (requested < 0) return { content: [{ type: "text" as const, text: `gh_pr_feedback failed to read PR: ${requested} is not a PR number` }], isError: true };
			// 0, like no number, means the PR for the current branch.
			const number = requested > 0 ? requested : undefined;
			const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number.isFinite(params.limit) ? (params.limit as number) : DEFAULT_LIMIT)));
			const includeAnnotations = params.includeAnnotations !== false;
			const repo = params.repo && params.repo.trim() ? params.repo.trim() : undefined;
			const collected = await collectPrFeedback(processRunner(ctx.cwd), { number, repo, includeResolved: Boolean(params.includeResolved), includeOutdated: Boolean(params.includeOutdated), includeAnnotations, limit });
			if (!collected.ok) {
				const what = collected.stage === "find" ? "could not find PR" : "failed to read PR";
				return { content: [{ type: "text" as const, text: `gh_pr_feedback ${what}: ${collected.error}` }], isError: true };
			}
			const feedback = collected.feedback;
			const text = renderText(feedback, { limit, includeAnnotations });
			const details = { number: feedback.number, repo: feedback.repo, threadReadError: feedback.threads.error ?? undefined, checkCount: feedback.checkRuns.items.length + feedback.statuses.items.length, annotationCount: feedback.annotations.items.length };
			return { content: [{ type: "text" as const, text }], details };
		},
	});
}
