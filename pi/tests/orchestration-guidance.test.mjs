import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const piRoot = new URL("../", import.meta.url);

async function readPiFile(relativePath) {
	const contents = await readFile(new URL(relativePath, piRoot), "utf8");
	assert.ok(contents.length > 0, `${relativePath} must not be empty`);
	return contents;
}

test("singleton guidance stays direct and reserves workflowScript for workflows", async () => {
	const streams = await readPiFile("WORKTREE_STREAMS.md");
	for (const [name, guidance] of [["WORKTREE_STREAMS.md", streams]]) {
		assert.match(guidance, /(direct[^\n]*singleton|singleton[^\n]*direct)/i, `${name} must prescribe direct singleton execution`);
		assert.match(guidance, /\{[^\n]*agent[^\n]*task[^\n]*delegationReason/i, `${name} must show the direct execution shape`);
		assert.match(guidance, /(workflowScript[^\n]*(only|reserve)|(only|reserve)[^\n]*workflowScript)/i, `${name} must reserve workflowScript for workflow control`);
		assert.doesNotMatch(guidance, /workflowScript[^\n]*(every launch|one-child)/i, `${name} must not prescribe singleton workflows`);
	}
});

test("/tasks advertises direct-first bounded orchestration", async () => {
	const { default: registerWorkflows } = await import("../extensions/workflows.ts");
	let tasksCommand;
	registerWorkflows({
		registerCommand(name, command) {
			if (name === "tasks") tasksCommand = command;
		},
	});
	assert.ok(tasksCommand, "/tasks command must be registered");
	assert.equal(typeof tasksCommand.handler, "function", "/tasks command must have a handler");

	let tasksGuidance;
	await tasksCommand.handler("", {
		ui: {
			pasteToEditor(text) {
				tasksGuidance = text;
			},
		},
	});
	assert.equal(typeof tasksGuidance, "string", "/tasks must paste guidance into the editor");
	assert.match(tasksGuidance, /direct default[^\n]*delegationReason[^\n]*one justified child/i);
	assert.match(tasksGuidance, /workflowScript only for workflow-only control/i);
	assert.match(tasksGuidance, /outputSchema[^\n]*structuredOutput/i);
	assert.match(tasksGuidance, /parent chooses strategy[^\n]*topology/i);
	assert.match(tasksGuidance, /one writer[^\n]*isolated worktrees/i);
	assert.match(tasksGuidance, /wait only at a real dependency barrier/i);
	assert.match(tasksGuidance, /status is diagnostic[^\n]*never routine polling/i);
	assert.match(tasksGuidance, /dependent work branches after observing output/i);
	assert.match(tasksGuidance, /omit transcripts[^\n]*broad context bundles/i);
	assert.match(tasksGuidance, /attested\/checked\/verified[^\n]*review is separate/i);
	assert.match(tasksGuidance, /review:\s*\{\s*required:\s*false\s*\}/i);
	assert.match(tasksGuidance, /async workflows have no default timeout/i);

	for (const relativePath of ["AGENTS.md", "WORKTREE_STREAMS.md"]) {
		const guidance = await readPiFile(relativePath);
		assert.doesNotMatch(guidance, /(?<!subagent_)\bwait\s*\(/, `${relativePath} must use the registered subagent_wait tool name`);
		assert.doesNotMatch(guidance, /`reviewed`|\breviewed acceptance/, `${relativePath} must not present reviewed as an acceptance level`);
		assert.match(guidance, /\battested\b[^\n]*\bchecked\b[^\n]*\bverified\b/, `${relativePath} must list current evidence levels`);
		assert.match(guidance, /review:\s*\{\s*required:\s*false\s*\}/, `${relativePath} must describe the separate optional review gate`);
		if (relativePath === "AGENTS.md") {
			assert.match(guidance, /Choose child models and thinking levels through explicit role profiles or per-run overrides\.[^\n]*never change the parent profile, agent role, topology, tools, permissions, context, worktree, or acceptance policy\./);
			assert.match(guidance, /no child reviewer[^\n]*one fresh reviewer[^\n]*two fresh reviewers/i);
			for (const reason of ["user_async", "independent_parallel_lane", "manager_continuity", "unresolved_ownership", "semantic_review", "elevated_risk_review"]) assert.match(guidance, new RegExp(`\\b${reason}\\b`));
			assert.match(guidance, /standing request: spawn subagents without asking/i);
			assert.match(guidance, /focused re-review[^\n]*unresolved semantic findings[^\n]*fix blast radius/i);
			assert.match(guidance, /Do not repeat broad review waves[^\n]*machine-decided corrections/i);
		}
	}
});
