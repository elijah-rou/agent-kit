import assert from "node:assert/strict";
import { afterAll, mock, test } from "bun:test";

// Pi supplies the real pi-ai modules at runtime. The stubs keep createProvider's passthrough shape and
// the completions API handle, so this file exercises the extension's own metadata, auth, and overlay
// logic rather than pi-ai.
mock.module("@earendil-works/pi-ai", () => ({ createProvider: (config) => config }));
mock.module("@earendil-works/pi-ai/compat", () => ({ openAICompletionsApi: () => ({ api: "openai-completions" }) }));

const { default: registerLithosai } = await import("../extensions/lithosai.ts");

// The overlay tests replace the global fetch; put it back so a later test file cannot inherit the stub.
const realFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; });

function provider() {
  let registered;
  registerLithosai({ registerProvider: (value) => { registered = value; } });
  assert.ok(registered, "the extension registers a provider");
  return registered;
}

const API_KEY_ENV = "LITHOSAI_API_KEY";
const EXPECTED_THINKING_LEVELS = { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" };

function cost(input, output, cacheRead) {
  return { input, output, cacheRead, cacheWrite: input };
}

function catalogEntry(id) {
  return provider().models.find((model) => model.id === id);
}

test("the registered provider serves the OpenAI-compatible endpoint with a conservative baseline catalog", () => {
  const lithosai = provider();
  assert.equal(lithosai.id, "lithosai");
  assert.equal(lithosai.name, "LithosAI");
  assert.equal(lithosai.baseUrl, "https://api.lithosai.cloud/v1");
  assert.deepEqual(lithosai.api, { api: "openai-completions" });
  assert.deepEqual(lithosai.models.map((model) => model.id), ["moonshotai/Kimi-K3", "moonshotai/Kimi-K3-fast"]);
  assert.ok(lithosai.auth?.apiKey, "an API-key login flow is registered");
  assert.equal(typeof lithosai.fetchModels, "function");

  assert.deepEqual(catalogEntry("moonshotai/Kimi-K3"), {
    id: "moonshotai/Kimi-K3",
    name: "Kimi K3",
    api: "openai-completions",
    provider: "lithosai",
    baseUrl: "https://api.lithosai.cloud/v1",
    input: ["text"],
    cost: cost(2.4, 12, 0.24),
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    type: "chat",
    compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    thinkingLevelMap: EXPECTED_THINKING_LEVELS,
  });
  // The fast tier bills its own rates and the display name keeps every word of the slug.
  assert.deepEqual(catalogEntry("moonshotai/Kimi-K3-fast").cost, cost(4, 20, 0.4));
  assert.equal(catalogEntry("moonshotai/Kimi-K3-fast").name, "Kimi K3 Fast");
});

test("login stores the pasted key, and resolve prefers it over the environment", async () => {
  const { login, resolve } = provider().auth.apiKey;
  const signal = new AbortController().signal;
  const prompted = [];
  const interaction = { signal, prompt: async (options) => { prompted.push(options); return "  key-from-login \n"; } };

  assert.deepEqual(await login(interaction), { type: "api_key", key: "key-from-login" });
  assert.equal(prompted[0].type, "secret");

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(login({ signal: aborted.signal, prompt: async () => "key" }), { name: "AbortError" });
  await assert.rejects(login({ signal, prompt: async () => "   " }), { message: "Login cancelled" });

  const ctx = { env: async () => "env-key" };
  const stored = await resolve({ ctx, credential: { key: " stored-key ", env: { [API_KEY_ENV]: "env-key" } }, signal });
  assert.deepEqual(stored, { auth: { apiKey: "stored-key" }, env: { [API_KEY_ENV]: "env-key" }, source: "auth.json" });

  const ambient = await resolve({ ctx, credential: undefined, signal });
  assert.deepEqual(ambient, { auth: { apiKey: "env-key" }, source: API_KEY_ENV });

  assert.equal(await resolve({ ctx: { env: async () => "" }, credential: undefined, signal }), undefined);
});

test("the live overlay fills context and tiered pricing by family", async () => {
  const requested = [];
  const baseUrl = "https://overlay.test/v1/";
  globalThis.fetch = async (url, options) => {
    requested.push({ url, options });
    return new Response(
      JSON.stringify({
        data: [
          { id: "moonshotai/Kimi-K3-ultra" },
          { id: "zai-org/GLM-5.3-flash-ultra" },
          { id: "zai-org/GLM-5.3" },
          { id: "deepseek-ai/DeepSeek-V4.1-Flash-fast" },
          { id: "acme/mystery-1", object: "model" },
          { id: 42 },
          {},
        ],
      }),
      { status: 200 },
    );
  };

  const models = await provider().fetchModels({
    credential: { type: "api_key", key: "overlay-key" },
    baseUrl,
    signal: new AbortController().signal,
  });

  // A trailing slash on the base URL never doubles, and the key travels as a bearer token.
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, "https://overlay.test/v1/models");
  assert.equal(requested[0].options.headers.Authorization, "Bearer overlay-key");
  // Entries without a string id drop out; the rest keep their position.
  assert.deepEqual(models.map((model) => model.id), [
    "moonshotai/Kimi-K3-ultra",
    "zai-org/GLM-5.3-flash-ultra",
    "zai-org/GLM-5.3",
    "deepseek-ai/DeepSeek-V4.1-Flash-fast",
    "acme/mystery-1",
  ]);

  const byId = (id) => models.find((model) => model.id === id);
  assert.deepEqual(byId("moonshotai/Kimi-K3-ultra").cost, cost(5.6, 28, 0.56));
  assert.deepEqual(byId("zai-org/GLM-5.3-flash-ultra").cost, cost(0.3, 1, 0.06));
  assert.deepEqual(byId("zai-org/GLM-5.3").cost, cost(1.05, 3.3, 0.195));
  assert.deepEqual(byId("deepseek-ai/DeepSeek-V4.1-Flash-fast").cost, cost(0.25, 1, 0.005));

  // An unknown family keeps the shared window with no reasoning claim and no pricing guess.
  const unknown = byId("acme/mystery-1");
  assert.equal(unknown.reasoning, false);
  assert.deepEqual(unknown.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(unknown.contextWindow, 1_048_576);
  assert.equal(unknown.maxTokens, 32_768);
  assert.equal(unknown.compat, undefined);
  assert.equal(unknown.thinkingLevelMap, undefined);
});

test("the overlay fails loudly instead of reporting an empty catalog", async () => {
  const fetchModels = provider().fetchModels;
  const credential = { type: "api_key", key: "overlay-key" };
  const signal = new AbortController().signal;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 200 }); };

  await assert.rejects(fetchModels({ credential: { type: "api_key" }, signal }), /Run \/login lithosai or set LITHOSAI_API_KEY/);
  assert.equal(calls, 0, "no keyless request is made");

  globalThis.fetch = async () => { calls += 1; return new Response("nope", { status: 401, statusText: "Unauthorized" }); };
  await assert.rejects(fetchModels({ credential, signal }), /401 Unauthorized/);

  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  await assert.rejects(fetchModels({ credential, signal }), /returned no usable models/);
});
