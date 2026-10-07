import { describe, expect, test } from "bun:test";
import { endsOnBlocker } from "../src/interaction.ts";

describe("endsOnBlocker", () => {
	test.each([
		["Needs you: nothing\n\nRefactored the parser and its tests.", false],
		["**Needs you:** nothing\n\nRefactored the parser.", false],
		["Needs you: none.\nMore prose.", false],
		["## Needs you\n\nNothing.\n\n## Done\nRefactored.", false],
		["## Done\nRefactored the parser.", false],
		["Needs you: choose the merge style for PR 12.\n\nDetails follow.", true],
		["**Needs you:** approve the schema change.", true],
		["## Needs you\n\n- Pick a cache size.\n\n## Done\nRest.", true],
		["Needs you:\n- Confirm the rollout window.", true],
		["**Needs you:** pick the auth provider (recommend Clerk; default Clerk tomorrow).\n\nDone: login page.", true],
		["## Needs you\nApprove the schema change.\n\n## Done\n- x", true],
		["**Needs you:** nothing.\n\n**Done:** shipped the fix.", false],
		["Fixed the bug and ran the tests.", false],
		["**Needs you:**\nnothing\n\n**Outcome:** shipped.", false],
		["**Needs you:**\nPick the cache size.\n\n**Outcome:** shipped.", true],
		["## Needs you\n\n**Decide** the cache size.\n\n## Done\nRest.", true],
	])("%j -> %p", (report, blocker) => {
		expect(endsOnBlocker(report)).toBe(blocker);
	});
});
