import { describe, expect, test } from "bun:test";
import { isPublic, isTask, sendable } from "./egress.ts";
import { seededCache } from "./testing.ts";

describe("what leaves the machine", () => {
	test("short follow-ups are not tasks", () => {
		expect(isTask("yes, continue")).toBe(false);
		expect(isTask("Change the launcher's languages subcommand to a flag")).toBe(true);
	});

	test("credential-shaped text is never sent, and home directories are redacted", () => {
		expect(sendable(`rotate the key ${"sk-" + "a".repeat(24)} in config`)).toBeUndefined();
		expect(sendable(`use ${"ghp_" + "b".repeat(30)}`)).toBeUndefined();
		expect(sendable("set password=hunter2hunter2 in the env file")).toBeUndefined();
		const typesafe = "apikey_" + "0".repeat(34) + "_" + "c".repeat(64);
		expect(sendable(`use the jev api directly, I have an api key: ${typesafe}`)).toBeUndefined();
		expect(sendable(`here it is ${typesafe}`)).toBeUndefined();
		expect(sendable(`configure Jev with _${typesafe}_ for this project`)).toBeUndefined();
		expect(sendable("the api  key: abcd1234efgh5678 for staging")).toBeUndefined();
		expect(sendable("my api key: abcdefgh12345678 for staging")).toBeUndefined();
		expect(sendable("rename the token parser module and update its callers")).toBe("rename the token parser module and update its callers");
		expect(sendable("document the apikey_ prefix rule and the api key rotation steps")).toBe("document the apikey_ prefix rule and the api key rotation steps");
		const [mac, linux] = ["/" + "Users/someone", "/" + "home/dev"];
		expect(sendable(`fix the build script in ${mac}/src/app and ${linux}/x`)).toBe("fix the build script in ~/src/app and ~/x");
	});

	test("a future-dated or failed cache entry is not trusted as public", async () => {
		const future = seededCache("o/r", { visibility: "PUBLIC", at: Date.now() + 10 * 86_400_000 });
		expect(await isPublic("o/r", { env: future, timeoutMs: 0 })).toBe(false);
		const failed = seededCache("o/r", { visibility: "UNKNOWN", at: Date.now() });
		expect(await isPublic("o/r", { env: failed, timeoutMs: 0 })).toBe(false);
		const fresh = seededCache("o/r", { visibility: "PUBLIC", at: Date.now() });
		expect(await isPublic("o/r", { env: fresh, timeoutMs: 0 })).toBe(true);
		expect(await isPublic("o/r", { env: fresh, fresh: true, timeoutMs: 0 })).toBe(false);
	});
});
