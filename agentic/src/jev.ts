// Minimal client for TypeSafe's Jev classifier (design D3, O9).
// Every failure is returned as a typed `unavailable` result; nothing throws into callers,
// because the policy layer treats unavailability as "ask the user".

import { redact, type Redaction } from "./redact.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const DEFAULT_TIMEOUT_MS = 3_000;
export const MAX_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 3;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface JevUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type UnavailableReason = "not-configured" | "timeout" | "network" | "http" | "malformed";

export interface JevUnavailable {
  readonly kind: "unavailable";
  readonly reason: UnavailableReason;
  readonly detail: string;
  readonly latencyMs: number;
  readonly status?: number;
}

interface JevOkBase {
  readonly kind: "ok";
  readonly model: string;
  readonly latencyMs: number;
  readonly usage: JevUsage;
}

export interface NoulOk extends JevOkBase {
  // Probability that the answer to the question is "yes".
  readonly probability: number;
}

export interface ChoiceOk<C extends string> extends JevOkBase {
  readonly choice: C;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<C, number>>;
}

export type NoulResult = NoulOk | JevUnavailable;
export type ChoiceResult<C extends string> = ChoiceOk<C> | JevUnavailable;

export type JevState = string | Readonly<Record<string, unknown>>;

export interface JevClientOptions {
  // Absent or empty means Jev is not configured; every call returns `unavailable`.
  readonly apiKey: string | undefined;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  // Retries apply only to network errors, timeouts, 429, and 5xx. Default 0.
  readonly retries?: number;
  readonly endpoint?: string;
  readonly model?: string;
  readonly now?: () => number;
}

export interface JevClient {
  noul(state: JevState, instructions: string): Promise<NoulResult>;
  choice<C extends string>(
    state: JevState,
    instructions: string,
    criteria: Readonly<Record<C, string>>,
  ): Promise<ChoiceResult<C>>;
}

const QUESTION = "q";

type RawAnswer = Record<string, unknown>;
type RawOk = { kind: "raw"; model: string; answer: RawAnswer; usage: JevUsage; latencyMs: number };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

export function createJevClient(options: JevClientOptions): JevClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? 0;
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`timeoutMs must be an integer in (0, ${MAX_TIMEOUT_MS}], got ${timeoutMs}`);
  }
  if (!(Number.isInteger(retries) && retries >= 0 && retries <= MAX_RETRIES)) {
    throw new RangeError(`retries must be an integer in [0, ${MAX_RETRIES}], got ${retries}`);
  }
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const model = options.model ?? JEV_MODEL;
  const now = options.now ?? (() => performance.now());

  async function attempt(question: Record<string, unknown>, state: JevState): Promise<RawOk | JevUnavailable> {
    const started = now();
    const elapsed = () => Math.round(now() - started);
    const unavailable = (reason: UnavailableReason, detail: string, status?: number): JevUnavailable => ({
      kind: "unavailable",
      reason,
      detail,
      latencyMs: elapsed(),
      ...(status === undefined ? {} : { status }),
    });

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions: { [QUESTION]: question } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return unavailable("timeout", `no response within ${timeoutMs} ms`);
      }
      return unavailable("network", error instanceof Error ? error.message : String(error));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return unavailable("timeout", `body not received within ${timeoutMs} ms`, response.status);
      }
      return unavailable(response.ok ? "malformed" : "http", `HTTP ${response.status}, non-JSON body`, response.status);
    }
    if (!response.ok) {
      return unavailable("http", `HTTP ${response.status}`, response.status);
    }
    if (!isRecord(body) || !isRecord(body.answers) || !isRecord(body.answers[QUESTION])) {
      return unavailable("malformed", "response has no answer for the question");
    }
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      kind: "raw",
      model: typeof body.model === "string" ? body.model : "unknown",
      answer: body.answers[QUESTION] as RawAnswer,
      usage: {
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      },
      latencyMs: elapsed(),
    };
  }

  const retryable = (r: JevUnavailable) =>
    r.reason === "network" ||
    r.reason === "timeout" ||
    (r.reason === "http" && r.status !== undefined && (r.status === 429 || r.status >= 500));

  async function ask(question: Record<string, unknown>, state: JevState): Promise<RawOk | JevUnavailable> {
    if (!options.apiKey) {
      return { kind: "unavailable", reason: "not-configured", detail: "no API key", latencyMs: 0 };
    }
    let result = await attempt(question, state);
    for (let i = 0; i < retries && result.kind === "unavailable" && retryable(result); i++) {
      result = await attempt(question, state);
    }
    return result;
  }

  return {
    async noul(state, instructions) {
      const raw = await ask({ type: "noul", instructions }, state);
      if (raw.kind === "unavailable") return raw;
      const p = raw.answer.noul;
      if (raw.answer.type !== "noul" || !isProbability(p)) {
        return { kind: "unavailable", reason: "malformed", detail: "noul answer missing probability", latencyMs: raw.latencyMs };
      }
      return { kind: "ok", model: raw.model, latencyMs: raw.latencyMs, usage: raw.usage, probability: p };
    },

    async choice<C extends string>(state: JevState, instructions: string, criteria: Readonly<Record<C, string>>) {
      const choices = Object.keys(criteria) as C[];
      if (choices.length < 2) throw new RangeError("choice needs at least two options");
      const raw = await ask({ type: "choice", instructions, criteria }, state);
      if (raw.kind === "unavailable") return raw;
      const { choice, confidence, probabilities } = raw.answer;
      const valid =
        raw.answer.type === "choice" &&
        typeof choice === "string" &&
        choices.includes(choice as C) &&
        isProbability(confidence) &&
        isRecord(probabilities) &&
        choices.every((o) => isProbability(probabilities[o]));
      if (!valid) {
        return { kind: "unavailable", reason: "malformed", detail: "choice answer malformed", latencyMs: raw.latencyMs };
      }
      return {
        kind: "ok",
        model: raw.model,
        latencyMs: raw.latencyMs,
        usage: raw.usage,
        choice: choice as C,
        confidence: confidence as number,
        probabilities: Object.fromEntries(choices.map((o) => [o, probabilities[o]])) as Record<C, number>,
      } satisfies ChoiceOk<C>;
    },
  };
}

// The friction-filter question for unclassified commands (design L2 step 3).
export const HARD_POINT_INSTRUCTIONS =
  "The state is a shell command an automated agent wants to run; secrets are replaced by <redacted:...> placeholders. " +
  "Answer yes if running it could publish code or artifacts to a remote (for example git push, a release, or a package publish), " +
  "merge a pull request, or post a comment or message that a person would read. " +
  "This includes effects reached indirectly: through bash -c, sh -c, eval, heredocs, scripts it writes or runs, " +
  "subprocesses in python, node, or bun, HTTP requests, git aliases, xargs, remote shells, or encoded or opaque payloads that are executed. " +
  "Answer no if it only reads, builds, tests, or changes local state, or if a publish is explicitly a dry run.";

export interface CommandClassification {
  readonly redacted: Redaction;
  readonly result: NoulResult;
}

// Caller-facing helper: redacts first, so command text never reaches the network unredacted.
export async function classifyUnreadableCommand(client: JevClient, command: string): Promise<CommandClassification> {
  const redacted = redact(command);
  const result = await client.noul({ command: redacted.text }, HARD_POINT_INSTRUCTIONS);
  return { redacted, result };
}

export type FrictionDecision =
  | { readonly decision: "proceed"; readonly probability: number }
  | { readonly decision: "ask-user"; readonly why: "likely-hard-point" | "uncertain" | "unavailable"; readonly probability?: number };

// A confident "no" (P(yes) at or below the threshold) proceeds. Everything else asks the user.
export function frictionDecision(result: NoulResult, threshold: number): FrictionDecision {
  if (!(isProbability(threshold) && threshold < 0.5)) {
    throw new RangeError(`threshold must be a probability below 0.5, got ${threshold}`);
  }
  if (result.kind === "unavailable") return { decision: "ask-user", why: "unavailable" };
  const p = result.probability;
  if (p <= threshold) return { decision: "proceed", probability: p };
  return { decision: "ask-user", why: p >= 0.5 ? "likely-hard-point" : "uncertain", probability: p };
}
