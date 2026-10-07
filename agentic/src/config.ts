/**
 * User-level configuration for the policy layer, kept outside every repository next to the
 * grants file: $AGENTIC_HOME/config.toml (default ~/.config/agentic/config.toml).
 *
 *   [jev]
 *   enabled = true
 *   threshold = 0.05   # proceed only when P(yes) <= threshold; must be below 0.5
 *
 * The TypeSafe key is never stored here. It comes from TYPESAFE_API_KEY, or on macOS from the
 * keychain item with service "typesafe-jev". Environment variables override the file for tests:
 * AGENTIC_JEV_THRESHOLD (empty disables).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgenticConfig {
	jev: { enabled: boolean; threshold: number };
}

const DEFAULTS: AgenticConfig = { jev: { enabled: false, threshold: 0.05 } };

export function agenticHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENTIC_HOME ?? join(homedir(), ".config", "agentic");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agenticHome(env), "config.toml");
}

/** Strict parse; a malformed config throws, which the pipeline turns into a denial. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AgenticConfig {
	const config: AgenticConfig = { jev: { ...DEFAULTS.jev } };
	const file = configPath(env);
	if (existsSync(file)) {
		const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as { jev?: { enabled?: unknown; threshold?: unknown } };
		if (parsed.jev !== undefined) {
			if (parsed.jev.enabled !== undefined) {
				if (typeof parsed.jev.enabled !== "boolean") throw new Error(`${file}: jev.enabled must be a boolean`);
				config.jev.enabled = parsed.jev.enabled;
			}
			if (parsed.jev.threshold !== undefined) {
				if (typeof parsed.jev.threshold !== "number" || !(parsed.jev.threshold >= 0 && parsed.jev.threshold < 0.5)) throw new Error(`${file}: jev.threshold must be a number in [0, 0.5)`);
				config.jev.threshold = parsed.jev.threshold;
			}
		}
	}
	if (env.AGENTIC_JEV_THRESHOLD !== undefined) {
		const raw = env.AGENTIC_JEV_THRESHOLD.trim();
		if (raw === "") config.jev.enabled = false;
		else {
			const threshold = Number(raw);
			if (!(threshold >= 0 && threshold < 0.5)) throw new Error(`AGENTIC_JEV_THRESHOLD must be a number in [0, 0.5): ${raw}`);
			config.jev = { enabled: true, threshold };
		}
	}
	return config;
}

/** The TypeSafe key from the environment or the macOS keychain; undefined when absent. */
export function typesafeKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
	if (process.platform !== "darwin" || env.AGENTIC_NO_KEYCHAIN === "1") return undefined;
	try {
		const key = execFileSync("security", ["find-generic-password", "-s", "typesafe-jev", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
		return key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}
