import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { jevFilterFromConfig } from "../src/jev-filter.ts";

const homes: string[] = [];

function home(config?: string): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "agentic-config-"));
	homes.push(dir);
	if (config !== undefined) writeFileSync(join(dir, "config.toml"), config);
	return { AGENTIC_HOME: dir, AGENTIC_NO_KEYCHAIN: "1" };
}

afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("user config", () => {
	test("Jev is off without a config file", () => {
		expect(readConfig(home())).toEqual({ jev: { enabled: false, threshold: 0.05 } });
	});

	test("[jev] enables the filter at the configured threshold", () => {
		expect(readConfig(home("[jev]\nenabled = true\nthreshold = 0.1\n"))).toEqual({ jev: { enabled: true, threshold: 0.1 } });
	});

	test("a threshold at or above 0.5 or a non-boolean switch fails loudly", () => {
		expect(() => readConfig(home("[jev]\nthreshold = 0.5\n"))).toThrow("jev.threshold");
		expect(() => readConfig(home('[jev]\nenabled = "yes"\n'))).toThrow("jev.enabled");
	});

	test("an empty AGENTIC_JEV_THRESHOLD disables Jev over the file", () => {
		expect(readConfig({ ...home("[jev]\nenabled = true\n"), AGENTIC_JEV_THRESHOLD: "" }).jev.enabled).toBe(false);
	});

	test("without a key the enabled filter reports Jev unavailable, so the call asks", async () => {
		const filter = jevFilterFromConfig({ ...home("[jev]\nenabled = true\n") });
		expect(filter).toBeDefined();
		expect(await filter!("python3 -c 'print(1)'")).toMatchObject({ kind: "unavailable" });
	});
});
