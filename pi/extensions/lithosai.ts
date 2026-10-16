/**
 * LithosAI provider extension for pi.
 *
 * LithosAI (https://lithosai.com) is a hosted OpenAI-compatible Chat
 * Completions endpoint. It is not in pi's built-in catalog, so this extension
 * registers a complete `Provider` with:
 *
 *   - an API-key `/login` flow (stored in auth.json by pi) plus
 *     `LITHOSAI_API_KEY` as the ambient fallback, and
 *   - a live `/v1/models` overlay, since GET /v1/models only returns
 *     `{ id, object, created, owned_by }` with no context/pricing metadata.
 *
 * Requests are delegated to pi-ai's built-in OpenAI Chat Completions
 * implementation, so message conversion, tool handling, usage accounting,
 * cancellation, and reasoning-effort behavior stay identical to built-ins.
 *
 * Obtaining a key: https://console.lithosai.cloud/keys
 *
 * Baseline model metadata is deliberately conservative. Every model serves a
 * 1,048,576-token context window and a 32,768-token output cap; pricing and the
 * model set are filled in from the live overlay after login (see `FAMILIES`
 * below). The DeepSeek/GLM author slugs are still unconfirmed — the LithosAI
 * console Models page and GET /v1/models are the source of truth.
 */

import {
  createProvider,
  type Model,
  type ProviderAuth,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "lithosai";
const PROVIDER_NAME = "LithosAI";
const BASE_URL = "https://api.lithosai.cloud/v1";
const API_KEY_ENV = "LITHOSAI_API_KEY";
const KEYS_URL = "https://console.lithosai.cloud/keys";

type LithosChatModel = Model<"openai-completions">;

// =============================================================================
// Reasoning metadata (vendor template, verbatim)
// =============================================================================

/** LithosAI's official pi integration template uses these compat flags. */
const OPENAI_COMPAT: NonNullable<LithosChatModel["compat"]> = {
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
};

/** LithosAI's official pi integration template maps pi levels like this. */
const THINKING_LEVEL_MAP: NonNullable<LithosChatModel["thinkingLevelMap"]> = {
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

// =============================================================================
// Pricing table (USD per 1M tokens; cacheWrite is charged at the input rate)
// =============================================================================

type Tier = "base" | "fast" | "ultra";

interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
}

interface FamilyPricing {
  /**
   * Lowercased slug (the part after the last "/") of a *tier-stripped* model
   * id. Matching is prefix-based, so more specific slugs must come first
   * (`glm-5.3-flash` before `glm-5.3`).
   */
  slug: string;
  /** Context window; every LithosAI model serves 1,048,576 tokens. */
  contextWindow: number;
  reasoning: boolean;
  tiers: Partial<Record<Tier, CostRates>>;
}

/** Confirmed prices from lithosai.com/pricing. Unlisted tier -> base rates. */
const FAMILIES: readonly FamilyPricing[] = [
  {
    slug: "kimi-k3",
    reasoning: true,
    contextWindow: 1_048_576,
    tiers: {
      base: { input: 2.4, output: 12, cacheRead: 0.24 },
      fast: { input: 4, output: 20, cacheRead: 0.4 },
      ultra: { input: 5.6, output: 28, cacheRead: 0.56 },
    },
  },
  {
    slug: "glm-5.3-flash",
    reasoning: true,
    contextWindow: 1_048_576,
    tiers: {
      base: { input: 0.15, output: 0.5, cacheRead: 0.03 },
      ultra: { input: 0.3, output: 1, cacheRead: 0.06 },
    },
  },
  {
    slug: "glm-5.3",
    reasoning: true,
    contextWindow: 1_048_576,
    tiers: {
      base: { input: 1.05, output: 3.3, cacheRead: 0.195 },
    },
  },
  {
    slug: "deepseek-v4.1-flash",
    reasoning: true,
    contextWindow: 1_048_576,
    tiers: {
      base: { input: 0.15, output: 0.6, cacheRead: 0.003 },
      fast: { input: 0.25, output: 1, cacheRead: 0.005 },
      ultra: { input: 0.35, output: 1.4, cacheRead: 0.007 },
    },
  },
];

const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/** Output cap; every catalog entry serves the same 32,768-token maximum. */
const DEFAULT_MAX_TOKENS = 32_768;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// =============================================================================
// Model metadata heuristics
// =============================================================================

function slugOf(id: string): string {
  const slash = id.lastIndexOf("/");
  return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

function tierOf(slug: string): Tier {
  if (slug.endsWith("-ultra")) return "ultra";
  if (slug.endsWith("-fast")) return "fast";
  return "base";
}

function baseSlugOf(slug: string, tier: Tier): string {
  return tier === "base" ? slug : slug.slice(0, slug.length - (`-${tier}`).length);
}

function displayName(id: string): string {
  return slugOf(id)
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function metadataFor(id: string): {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
} {
  const slug = slugOf(id);
  const tier = tierOf(slug);
  const baseSlug = baseSlugOf(slug, tier);
  const family = FAMILIES.find(
    (candidate) => baseSlug === candidate.slug || baseSlug.startsWith(`${candidate.slug}-`),
  );

  // Unknown family: stay conservative rather than guessing reasoning/pricing.
  if (!family) {
    return {
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoning: false,
      cost: ZERO_COST,
    };
  }

  const rates = family.tiers[tier] ?? family.tiers.base;
  if (!rates) {
    return {
      contextWindow: family.contextWindow,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoning: family.reasoning,
      cost: ZERO_COST,
    };
  }

  return {
    contextWindow: family.contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: family.reasoning,
    cost: {
      input: rates.input,
      output: rates.output,
      cacheRead: rates.cacheRead,
      // LithosAI charges cache writes at the input rate.
      cacheWrite: rates.input,
    },
  };
}

function buildModel(id: string): LithosChatModel {
  const meta = metadataFor(id);
  const model: LithosChatModel = {
    id,
    name: displayName(id),
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    // Vision support is unverified for every catalog entry; assume text-only.
    input: ["text"],
    cost: meta.cost,
    reasoning: meta.reasoning,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    type: "chat",
  };
  if (meta.reasoning) {
    model.compat = OPENAI_COMPAT;
    model.thinkingLevelMap = THINKING_LEVEL_MAP;
  }
  return model;
}

/** Works before login; replaced by the live overlay once the catalog is fetched. */
const BASELINE_MODELS: readonly LithosChatModel[] = [
  buildModel("moonshotai/Kimi-K3"),
  buildModel("moonshotai/Kimi-K3-fast"),
];

// =============================================================================
// Authentication
// =============================================================================

const auth: ProviderAuth = {
  apiKey: {
    name: `${PROVIDER_NAME} API key`,
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = (
        await interaction.prompt({
          type: "secret",
          message: "Paste your LithosAI API key",
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

// =============================================================================
// Live model overlay
// =============================================================================

/**
 * Pi only calls this once the provider resolves a credential, so no keyless
 * request is ever made. On any failure we throw: pi keeps the baseline/stored
 * list and surfaces a warning, which is safer than reporting an empty catalog.
 */
async function fetchModels(context: RefreshModelsContext): Promise<readonly LithosChatModel[]> {
  const credential = context.credential;
  const key =
    credential?.type === "api_key"
      ? credential.key?.trim() || credential.env?.[API_KEY_ENV]?.trim()
      : undefined;
  if (!key) {
    throw new Error(
      `Cannot list ${PROVIDER_NAME} models without an API key. Run /login ${PROVIDER_ID} or set ${API_KEY_ENV}.`,
    );
  }

  const baseUrl = (context.baseUrl ?? BASE_URL).replace(/\/+$/u, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: context.signal,
  });
  if (!response.ok) {
    throw new Error(
      `${PROVIDER_NAME} model listing failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as { data?: unknown };
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = entries
    .map((entry) =>
      entry && typeof entry === "object" && "id" in entry
        ? (entry as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => buildModel(id));

  if (models.length === 0) {
    throw new Error(`${PROVIDER_NAME} model listing returned no usable models`);
  }
  return models;
}

// =============================================================================
// Provider + extension entry point
// =============================================================================

function createLithosaiProvider() {
  return createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    auth,
    models: BASELINE_MODELS,
    api: openAICompletionsApi(),
    fetchModels,
  });
}

export default function lithosaiExtension(pi: ExtensionAPI): void {
  // ExtensionAPI exposes no provider getter (it offers `getModel`, not
  // `getProvider`), so register unconditionally. Re-registration replaces the
  // previous entry with this one.
  pi.registerProvider(createLithosaiProvider());
}
