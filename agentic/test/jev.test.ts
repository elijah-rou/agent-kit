import { describe, expect, test } from "bun:test";
import {
  classifyUnreadableCommand,
  createJevClient,
  frictionDecision,
  type FetchLike,
  type NoulResult,
} from "../src/jev.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const noulBody = (p: number) => ({
  model: "jev-1.13.0",
  answers: { q: { type: "noul", noul: p } },
  usage: { input_tokens: 300, output_tokens: 50 },
});

type Captured = { url: string; init: RequestInit };

function recordingFetch(respond: (n: number) => Response | Promise<Response>): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(calls.length);
    },
  };
}

describe("jev client", () => {
  test("noul returns the probability, usage, and model", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, noulBody(0.87)));
    const client = createJevClient({ apiKey: "test-key", fetch });
    const r = await client.noul({ command: "x" }, "does it publish?");
    expect(r).toMatchObject({ kind: "ok", probability: 0.87, model: "jev-1.13.0", usage: { inputTokens: 300, outputTokens: 50 } });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      model: "jev-latest",
      state: { command: "x" },
      questions: { q: { type: "noul", instructions: "does it publish?" } },
    });
    expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer test-key");
  });

  test("choice returns the typed choice and probabilities", async () => {
    const { fetch } = recordingFetch(() =>
      json(200, {
        model: "jev-1.13.0",
        answers: { q: { type: "choice", choice: "b", confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } } },
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    );
    const client = createJevClient({ apiKey: "k", fetch });
    const r = await client.choice("task", "pick", { a: "first", b: "second" });
    expect(r).toMatchObject({ kind: "ok", choice: "b", confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } });
  });

  test("choice outside the criteria is malformed, not ok", async () => {
    const { fetch } = recordingFetch(() =>
      json(200, { model: "m", answers: { q: { type: "choice", choice: "z", confidence: 1, probabilities: { z: 1 } } } }),
    );
    const r = await createJevClient({ apiKey: "k", fetch }).choice("t", "pick", { a: "1", b: "2" });
    expect(r).toMatchObject({ kind: "unavailable", reason: "malformed" });
  });

  test("missing key is not-configured and makes no request", async () => {
    const { fetch, calls } = recordingFetch(() => json(200, noulBody(0)));
    const r = await createJevClient({ apiKey: undefined, fetch }).noul("s", "q");
    expect(r).toMatchObject({ kind: "unavailable", reason: "not-configured" });
    expect(calls).toHaveLength(0);
  });

  test("timeout returns unavailable instead of throwing", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const r = await createJevClient({ apiKey: "k", fetch: hang, timeoutMs: 50 }).noul("s", "q");
    expect(r).toMatchObject({ kind: "unavailable", reason: "timeout" });
  });

  test("network error returns unavailable", async () => {
    const r = await createJevClient({
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("connection refused");
      },
    }).noul("s", "q");
    expect(r).toMatchObject({ kind: "unavailable", reason: "network", detail: "connection refused" });
  });

  test("HTTP error and malformed bodies return unavailable", async () => {
    const http = await createJevClient({ apiKey: "k", fetch: async () => json(401, { error: "bad key" }) }).noul("s", "q");
    expect(http).toMatchObject({ kind: "unavailable", reason: "http", status: 401 });
    const notJson = await createJevClient({ apiKey: "k", fetch: async () => new Response("<html>", { status: 200 }) }).noul("s", "q");
    expect(notJson).toMatchObject({ kind: "unavailable", reason: "malformed" });
    const outOfRange = await createJevClient({ apiKey: "k", fetch: async () => json(200, noulBody(1.5)) }).noul("s", "q");
    expect(outOfRange).toMatchObject({ kind: "unavailable", reason: "malformed" });
  });

  test("no retries by default; retries only when configured and retryable", async () => {
    const failing = recordingFetch(() => json(503, {}));
    await createJevClient({ apiKey: "k", fetch: failing.fetch }).noul("s", "q");
    expect(failing.calls).toHaveLength(1);

    const flaky = recordingFetch((n) => (n === 1 ? json(429, {}) : json(200, noulBody(0.2))));
    const r = await createJevClient({ apiKey: "k", fetch: flaky.fetch, retries: 2 }).noul("s", "q");
    expect(r).toMatchObject({ kind: "ok", probability: 0.2 });
    expect(flaky.calls).toHaveLength(2);

    const denied = recordingFetch(() => json(403, {}));
    await createJevClient({ apiKey: "k", fetch: denied.fetch, retries: 2 }).noul("s", "q");
    expect(denied.calls).toHaveLength(1);
  });

  test("rejects out-of-range options", () => {
    expect(() => createJevClient({ apiKey: "k", timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createJevClient({ apiKey: "k", retries: 9 })).toThrow(RangeError);
  });
});

describe("classifyUnreadableCommand", () => {
  test("redacts the command before it reaches the request body", async () => {
    const secrets = [
      "ghp" + "_Fake0Tok3nAbCdEfGhIjKlMnOpQrStUvWx12",
      "hunter2pass",
      "s3cretHeaderValue99",
      "plainvalue123",
    ];
    const command =
      `GH_TOKEN=${secrets[0]} bash -c 'git push https://bot:${secrets[1]}@git.example.com/o/r.git HEAD:main' && ` +
      `curl -H "Authorization: token ${secrets[2]}" -X POST https://api.example.com/c && TOKEN=${secrets[3]} ./x`;
    const { fetch, calls } = recordingFetch(() => json(200, noulBody(0.9)));
    const { redacted, result } = await classifyUnreadableCommand(createJevClient({ apiKey: "k", fetch }), command);

    expect(result).toMatchObject({ kind: "ok", probability: 0.9 });
    const sent = String(calls[0]!.init.body);
    for (const s of secrets) expect(sent).not.toContain(s);
    expect(sent).toContain("<redacted:");
    expect(JSON.parse(sent).state).toEqual({ command: redacted.text });
    expect(sent).toContain("git push");
  });
});

describe("frictionDecision", () => {
  const ok = (p: number): NoulResult => ({ kind: "ok", model: "m", latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0 }, probability: p });

  test("proceeds only at or below the threshold", () => {
    expect(frictionDecision(ok(0.01), 0.01)).toEqual({ decision: "proceed", probability: 0.01 });
    expect(frictionDecision(ok(0.02), 0.01)).toEqual({ decision: "ask-user", why: "uncertain", probability: 0.02 });
    expect(frictionDecision(ok(0.87), 0.01)).toEqual({ decision: "ask-user", why: "likely-hard-point", probability: 0.87 });
  });

  test("unavailable always asks the user", () => {
    expect(frictionDecision({ kind: "unavailable", reason: "timeout", detail: "", latencyMs: 3000 }, 0.3)).toEqual({
      decision: "ask-user",
      why: "unavailable",
    });
  });

  test("a threshold at or above 0.5 is a programmer error", () => {
    expect(() => frictionDecision(ok(0.1), 0.5)).toThrow(RangeError);
  });
});
