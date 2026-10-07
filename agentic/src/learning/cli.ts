#!/usr/bin/env bun
/**
 * Learning loop CLI (design D9). Run in the repository whose .agents/learning/ to use.
 *   consolidate     merge new session files (single writer, locked)
 *   approve <id>    promote a ready-for-review learning (the user's explicit approval)
 *   status [--json] list candidates, backlog, and what is ready for review
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approve, consolidate, learningDir, type LearningState } from "./learning.ts";

const [sub, ...rest] = process.argv.slice(2);
const root = process.cwd();

function usage(code: number): never {
	console.error("usage: learning consolidate | approve <id> | status [--json]");
	process.exit(code);
}

try {
	switch (sub) {
		case "consolidate": {
			const report = consolidate(root, new Date());
			console.log(JSON.stringify(report, null, 2));
			process.exit(report.malformed.length > 0 ? 1 : 0);
		}
		case "approve": {
			if (!rest[0]) usage(2);
			const candidate = approve(root, rest[0]);
			console.log(`approved ${candidate.id}: ${candidate.text}`);
			break;
		}
		case "status": {
			const file = join(learningDir(root), "state.json");
			const state: LearningState = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { processed: {}, candidates: [], backlog: [] };
			if (rest.includes("--json")) console.log(JSON.stringify(state, null, 2));
			else {
				for (const c of state.candidates) console.log(`${c.status.padEnd(16)} ${c.id} [${c.kind}] ${c.text} (${c.sessions.length} sessions)`);
				for (const b of state.backlog) console.log(`${"backlog".padEnd(16)} [${b.kind}] ${b.text}`);
				if (state.candidates.length + state.backlog.length === 0) console.log("no learnings yet");
			}
			break;
		}
		case "--help":
		case "-h":
			usage(0);
		default:
			usage(2);
	}
} catch (error) {
	console.error(`learning: ${(error as Error).message}`);
	process.exit(1);
}
