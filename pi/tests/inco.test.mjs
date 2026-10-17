import assert from "node:assert/strict";
import { afterAll, mock, test } from "bun:test";

// Pi supplies the real pi-ai modules at runtime. The stubs keep createProvider's passthrough shape
// and the completions API handle, so this file exercises the extension's own catalog, auth, and
// overlay logic rather than pi-ai.
mock.module("@earendil-works/pi-ai", () => ({ createProvider: (config) => config }));
mock.module("@earendil-works/pi-ai/compat", () => ({ openAICompletionsApi: () => ({ api: "openai-completions" }) }));

const { default: registerInco } = await import("../extensions/inco.ts");

// The overlay tests replace the global fetch; put it back so a later test file cannot inherit the stub.
const realFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; });

function provider() {
	let registered;
	registerInco({ registerProvider: (value) => { registered = value; } });
	assert.ok(registered, "the extension registers a provider");
	return registered;
}

const API_KEY_ENV = "INCO_API_KEY";
const EXPECTED_THINKING_LEVELS = { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };

function cost(input, output, cacheRead) {
	return { input, output, cacheRead, cacheWrite: input };
}

test("the registered provider serves the OpenAI dialect with a baseline catalog", () => {
	const inco = provider();
	assert.equal(inco.id, "inco");
	assert.equal(inco.name, "Inco");
	assert.equal(inco.baseUrl, "https://api.inco.ai/v1");
	assert.deepEqual(inco.api, { api: "openai-completions" });
	assert.deepEqual(inco.models.map((model) => model.id), ["kimi-k3", "glm-5.3-flash"]);
	assert.ok(inco.auth?.apiKey, "an API-key login flow is registered");
	assert.equal(typeof inco.fetchModels, "function");

	assert.deepEqual(inco.models[0], {
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: "inco",
		baseUrl: "https://api.inco.ai/v1",
		input: ["text"],
		cost: cost(3, 15, 0.3),
		reasoning: true,
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		type: "chat",
		compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
		thinkingLevelMap: EXPECTED_THINKING_LEVELS,
	});
	assert.deepEqual(inco.models[1].cost, cost(0.15, 0.5, 0.03));
});

test("login stores the pasted key, and resolve prefers it over the environment", async () => {
	const { login, resolve } = provider().auth.apiKey;
	const signal = new AbortController().signal;
	const prompted = [];
	const interaction = { signal, prompt: async (options) => { prompted.push(options); return "  sk-inco-test \n"; } };

	assert.deepEqual(await login(interaction), { type: "api_key", key: "sk-inco-test" });
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

test("the live overlay reads context, prices, modalities, and reasoning from each entry", async () => {
	const requested = [];
	globalThis.fetch = async (url, options) => {
		requested.push({ url, options });
		return new Response(
			JSON.stringify({
				object: "list",
				data: [
					{ id: "kimi-k3", object: "model", name: "Kimi K3", tier: "standard", context_length: 262_144, pricing: { input: 3, cached_input: 0.3, output: 15 }, capabilities: { reasoning_effort: true }, parameters: 2_800_000_000_000 },
					{ id: "glm-5.3-flash:fast", object: "model", name: "GLM 5.3 Flash (Fast)", tier: "fast", context_length: 1_048_576, pricing: { input: 0.3, cached_input: 0.06, output: 1 }, capabilities: { reasoning_effort: true }, modalities: { input: ["text", "image"], output: ["text"] } },
					{ id: "minimax-m3:fast", object: "model", pricing: { input: 0.6, cached_input: 0.12, output: 2.4 }, capabilities: { reasoning_effort: false }, modalities: { input: ["image"], output: ["text"] } },
					{ id: "deepseek-v4.1-flash", object: "model", name: "DeepSeek V4.1 Flash" },
					{ id: 42 },
					{},
					null,
				],
			}),
			{ status: 200 },
		);
	};

	const models = await provider().fetchModels({
		credential: { type: "api_key", key: " overlay-key " },
		baseUrl: "https://overlay.test/v1/",
		signal: new AbortController().signal,
	});

	// A trailing slash on the base URL never doubles, and the key travels as a bearer token.
	assert.equal(requested.length, 1);
	assert.equal(requested[0].url, "https://overlay.test/v1/models");
	assert.equal(requested[0].options.headers.Authorization, "Bearer overlay-key");
	assert.equal(requested[0].options.headers.Accept, "application/json");
	// Entries without a string id drop out; the rest keep their position and names.
	assert.deepEqual(models.map((model) => model.id), ["kimi-k3", "glm-5.3-flash:fast", "minimax-m3:fast", "deepseek-v4.1-flash"]);
	assert.deepEqual(models.map((model) => model.name), ["Kimi K3", "GLM 5.3 Flash (Fast)", "Minimax M3 Fast", "DeepSeek V4.1 Flash"]);

	const byId = (id) => models.find((model) => model.id === id);
	assert.deepEqual(byId("kimi-k3").cost, cost(3, 15, 0.3));
	// A write bills at the input rate; the fast tier prices its own reads.
	assert.deepEqual(byId("glm-5.3-flash:fast").cost, cost(0.3, 1, 0.06));
	// Modalities add to the text a chat model always takes; an entry that lists none stays text-only.
	assert.deepEqual(byId("glm-5.3-flash:fast").input, ["text", "image"]);
	assert.deepEqual(byId("minimax-m3:fast").input, ["text", "image"]);
	assert.deepEqual(byId("kimi-k3").input, ["text"]);
	// A model that does not report reasoning effort keeps the dialect compat without an effort.
	assert.equal(byId("minimax-m3:fast").reasoning, false);
	assert.deepEqual(byId("minimax-m3:fast").compat, { maxTokensField: "max_tokens" });
	assert.equal(byId("minimax-m3:fast").thinkingLevelMap, undefined);
	// An entry without prices keeps zero cost rather than a guess.
	assert.deepEqual(byId("deepseek-v4.1-flash").cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(byId("deepseek-v4.1-flash").reasoning, false);
	// Context windows come from the entry, and one that omits the field falls back to the shared window.
	assert.deepEqual(models.map((model) => model.contextWindow), [262_144, 1_048_576, 1_048_576, 1_048_576]);
});

test("the overlay sends the key it has, and asks for the public catalog without one", async () => {
	const requests = [];
	globalThis.fetch = async (url, request) => {
		requests.push(request);
		return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), { status: 200 });
	};

	const fetchModels = provider().fetchModels;
	const signal = new AbortController().signal;
	assert.deepEqual((await fetchModels({ credential: undefined, signal })).map((model) => model.id), ["kimi-k3"]);
	assert.equal(requests[0].headers.Authorization, undefined);

	const fromEnv = await fetchModels({ credential: { type: "api_key", env: { [API_KEY_ENV]: " env-key " } }, signal });
	assert.deepEqual(fromEnv.map((model) => model.id), ["kimi-k3"]);
	assert.equal(requests[1].headers.Authorization, "Bearer env-key");
});

test("the overlay fails loudly instead of reporting an empty catalog", async () => {
	const fetchModels = provider().fetchModels;
	const credential = { type: "api_key", key: "overlay-key" };
	const signal = new AbortController().signal;

	globalThis.fetch = async () => new Response("nope", { status: 402, statusText: "Payment Required" });
	await assert.rejects(fetchModels({ credential, signal }), /402 Payment Required/);

	globalThis.fetch = async () => new Response("<html>gateway</html>", { status: 200 });
	await assert.rejects(fetchModels({ credential, signal }), /returned no JSON/);

	globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ object: "model" }] }), { status: 200 });
	await assert.rejects(fetchModels({ credential, signal }), /returned no usable models/);
});