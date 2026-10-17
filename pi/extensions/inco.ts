/**
 * Inco provider extension for pi.
 *
 * Inco (https://platform.inco.ai) serves the OpenAI and Anthropic dialects from
 * one host and is not in pi's built-in catalog, so this extension registers a
 * complete `Provider` with:
 *
 *   - an API-key `/login` flow (stored in auth.json by pi) plus
 *     `INCO_API_KEY` as the ambient fallback, and
 *   - a live `/v1/models` overlay, whose entries carry the context length,
 *     prices and reasoning capability of every model they list.
 *
 * Requests are delegated to pi-ai's built-in OpenAI Chat Completions
 * implementation, so message conversion, tool handling, usage accounting,
 * cancellation, and reasoning-effort behavior stay identical to built-ins.
 *
 * Obtaining a key: https://platform.inco.ai/keys
 *
 * Two things the catalog does not settle. Every entry currently serves the same
 * window and no output limit, so `DEFAULT_MAX_TOKENS` is a conservative cap
 * rather than a published one. And `capabilities.reasoning_effort` is a boolean,
 * not the set of efforts a model takes, so `THINKING_LEVEL_MAP` names only the
 * OpenAI-compatible trio.
 */

import {
	createProvider,
	type Model,
	type ProviderAuth,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "inco";
const PROVIDER_NAME = "Inco";
const BASE_URL = "https://api.inco.ai/v1";
const API_KEY_ENV = "INCO_API_KEY";
const KEYS_URL = "https://platform.inco.ai/keys";

type IncoChatModel = Model<"openai-completions">;

/** Every catalog entry serves this window; it applies when an entry omits one. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/** The catalog publishes no output limit, so cap conservatively. */
const DEFAULT_MAX_TOKENS = 32_768;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Inco's docs describe `reasoning_effort` and `none` on the OpenAI dialect. */
const OPENAI_COMPAT: NonNullable<IncoChatModel["compat"]> = {
	supportsReasoningEffort: true,
	maxTokensField: "max_tokens",
};

/**
 * `capabilities.reasoning_effort` says a model reasons, not which efforts it
 * takes, and Inco refuses an effort a model does not document with a 400. The
 * trio every OpenAI-compatible reasoner documents is mapped; the rest stay
 * unsupported until the catalog names them, which pi clamps to a neighbour.
 */
const THINKING_LEVEL_MAP: NonNullable<IncoChatModel["thinkingLevelMap"]> = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};


/** The `/v1/models` fields this extension reads; every other field is ignored. */
interface CatalogEntry {
	id: string;
	name?: unknown;
	context_length?: unknown;
	pricing?: { input?: unknown; cached_input?: unknown; output?: unknown };
	capabilities?: { reasoning_effort?: unknown };
	modalities?: { input?: unknown };
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { id?: unknown }).id === "string" &&
		(value as { id: string }).id.length > 0
	);
}

/** A non-negative finite number, or undefined for anything the catalog formats differently. */
function rate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function inputModalities(value: unknown): IncoChatModel["input"] {
	const listed = Array.isArray(value) ? value : [];
	// Every model here answers a text prompt on the chat dialect; the catalog's list adds to that.
	return listed.includes("image") ? ["text", "image"] : ["text"];
}

function displayName(id: string): string {
	return id
		.split(/[-_:]/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function buildModel(entry: CatalogEntry): IncoChatModel {
	const input = rate(entry.pricing?.input);
	const output = rate(entry.pricing?.output);
	const cachedInput = rate(entry.pricing?.cached_input);
	const reasoning = entry.capabilities?.reasoning_effort === true;
	const name = typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : displayName(entry.id);

	const model: IncoChatModel = {
		id: entry.id,
		name,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		input: inputModalities(entry.modalities?.input),
		// The catalog prices cache reads only; a write bills at the input rate. An entry
		// without both rates keeps zero cost rather than a guess.
		cost:
			input !== undefined && output !== undefined
				? { input, output, cacheRead: cachedInput ?? 0, cacheWrite: input }
				: ZERO_COST,
		reasoning,
		contextWindow: rate(entry.context_length) || DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		type: "chat",
	};
	if (reasoning) {
		model.compat = OPENAI_COMPAT;
		model.thinkingLevelMap = THINKING_LEVEL_MAP;
	}
	return model;
}

/** Serves before the first overlay refresh and whenever a refresh fails. */
const BASELINE_MODELS: readonly IncoChatModel[] = [
	buildModel({
		id: "kimi-k3",
		name: "Kimi K3",
		context_length: DEFAULT_CONTEXT_WINDOW,
		pricing: { input: 3, cached_input: 0.3, output: 15 },
		capabilities: { reasoning_effort: true },
	}),
	buildModel({
		id: "glm-5.3-flash",
		name: "GLM 5.3 Flash",
		context_length: DEFAULT_CONTEXT_WINDOW,
		pricing: { input: 0.15, cached_input: 0.03, output: 0.5 },
		capabilities: { reasoning_effort: true },
	}),
];


const auth: ProviderAuth = {
	apiKey: {
		name: `${PROVIDER_NAME} API key`,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = (
				await interaction.prompt({
					type: "secret",
					message: "Paste your Inco API key",
					placeholder: KEYS_URL,
				})
			).trim();
			interaction.signal.throwIfAborted();
			if (!key) throw new Error("Login cancelled");
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			const storedKey = credential?.key?.trim();
			if (storedKey) {
				return { auth: { apiKey: storedKey }, env: credential?.env, source: "auth.json" };
			}
			const envKey = (credential?.env?.[API_KEY_ENV] ?? (await ctx.env(API_KEY_ENV)))?.trim();
			signal.throwIfAborted();
			if (envKey) {
				return { auth: { apiKey: envKey }, source: API_KEY_ENV };
			}
			return undefined;
		},
	},
};


/**
 * Pi only calls this once a credential resolves, which is why the key travels in
 * the request even though the catalog itself is public. On any failure we throw:
 * pi keeps the baseline or the stored list and surfaces a warning, which is
 * safer than reporting an empty catalog.
 */
async function fetchModels(context: RefreshModelsContext): Promise<readonly IncoChatModel[]> {
	const credential = context.credential;
	const key =
		credential?.type === "api_key"
			? credential.key?.trim() || credential.env?.[API_KEY_ENV]?.trim()
			: undefined;

	const headers: Record<string, string> = { Accept: "application/json" };
	if (key) headers.Authorization = `Bearer ${key}`;

	const baseUrl = (context.baseUrl ?? BASE_URL).replace(/\/+$/u, "");
	const response = await fetch(`${baseUrl}/models`, { headers, signal: context.signal });
	if (!response.ok) {
		throw new Error(
			`${PROVIDER_NAME} model listing failed: ${response.status} ${response.statusText}`,
		);
	}

	let payload: { data?: unknown };
	try {
		payload = (await response.json()) as { data?: unknown };
	} catch {
		throw new Error(`${PROVIDER_NAME} model listing returned no JSON`);
	}

	const entries = Array.isArray(payload?.data) ? payload.data : [];
	const models = entries.filter(isCatalogEntry).map(buildModel);
	if (models.length === 0) {
		throw new Error(`${PROVIDER_NAME} model listing returned no usable models`);
	}
	return models;
}


export default function incoExtension(pi: ExtensionAPI): void {
	pi.registerProvider(
		createProvider<"openai-completions">({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl: BASE_URL,
			auth,
			models: BASELINE_MODELS,
			api: openAICompletionsApi(),
			fetchModels,
		}),
	);
}