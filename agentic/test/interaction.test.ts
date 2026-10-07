import { describe, expect, test } from "bun:test";
import { endsOnBlocker } from "../src/interaction.ts";

describe("interaction contract", () => {
	test("a Needs you section with content is a blocker; nothing is not", () => {
		expect(endsOnBlocker("**Needs you:** pick the auth provider (recommend Clerk; default Clerk tomorrow).\n\nDone: login page.")).toBe(true);
		expect(endsOnBlocker("## Needs you\nApprove the schema change.\n\n## Done\n- x")).toBe(true);
		expect(endsOnBlocker("**Needs you:** nothing.\n\n**Done:** shipped the fix.")).toBe(false);
		expect(endsOnBlocker("Fixed the bug and ran the tests.")).toBe(false);
	});
});
