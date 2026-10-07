import { createJevClient, HARD_POINT_INSTRUCTIONS } from "./jev.ts";
import type { JevFilter, JevVerdict } from "./pipeline.ts";
import { redact } from "./redact.ts";
import { readConfig, typesafeKey } from "./config.ts";

/**
 * The question every adapter asks Jev about an unreadable command. The O9 threshold was
 * calibrated on exactly this wording (evals/jev/REPORT.md); changing it requires a rerun.
 */
export const HARD_POINT_QUESTION = HARD_POINT_INSTRUCTIONS;

/** Recommended threshold from evals/jev/REPORT.md: proceed only when P(yes) <= 0.05. */
export const RECOMMENDED_THRESHOLD = 0.05;

export function redactCommand(command: string): string {
	return redact(command).text;
}

/** Returns the probability of "yes", or undefined when Jev could not answer. */
export type NoulClassifier = (state: string, instructions: string) => Promise<number | undefined>;

export interface JevFilterOptions {
	classify: NoulClassifier;
	redact: (command: string) => string;
	/** A probability at or below this is a confident "no". */
	threshold: number;
}

/**
 * Builds the friction filter for unreadable calls. Redaction always runs before the network.
 * A confident "no" lets the call proceed; everything else, including errors, asks the user.
 */
export function makeJevFilter(options: JevFilterOptions): JevFilter {
	if (!(options.threshold >= 0 && options.threshold < 0.5)) throw new Error("Jev threshold must be in [0, 0.5)");
	return async (command: string): Promise<JevVerdict> => {
		const redacted = options.redact(command);
		let probability: number | undefined;
		try {
			probability = await options.classify(redacted, HARD_POINT_QUESTION);
		} catch (error) {
			return { kind: "unavailable", reason: (error as Error).message };
		}
		if (probability === undefined || !Number.isFinite(probability)) return { kind: "unavailable", reason: "no answer" };
		return probability <= options.threshold ? { kind: "confident-no", probability } : { kind: "yes-or-uncertain", probability };
	};
}

/**
 * The configured filter for every adapter: enabled by [jev] in $AGENTIC_HOME/config.toml (or
 * AGENTIC_JEV_THRESHOLD). The key comes from TYPESAFE_API_KEY or the macOS keychain, looked up
 * on the first unreadable call only; a missing key makes Jev unavailable, so the call asks.
 */
export function jevFilterFromConfig(env: NodeJS.ProcessEnv): JevFilter | undefined {
	const config = readConfig(env);
	if (!config.jev.enabled) return undefined;
	let client: ReturnType<typeof createJevClient> | undefined;
	return makeJevFilter({
		threshold: config.jev.threshold,
		redact: redactCommand,
		classify: async (state, instructions) => {
			if (!client) {
				const apiKey = typesafeKey(env);
				if (!apiKey) throw new Error("no TypeSafe key in TYPESAFE_API_KEY or the keychain item typesafe-jev");
				client = createJevClient({ apiKey });
			}
			const result = await client.noul({ command: state }, instructions);
			return result.kind === "unavailable" ? undefined : result.probability;
		},
	});
}
