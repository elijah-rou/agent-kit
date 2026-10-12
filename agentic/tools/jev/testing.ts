import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "./egress.ts";

// Shared by the Jev tests: a fake TypeSafe that always gives one answer, and a seeded visibility cache.
export const answering = (q: unknown, status = 200): FetchLike => async () => new Response(JSON.stringify({ answers: { q } }), { status });
export const options = (fetch: FetchLike) => ({ apiKey: "test-key", timeoutMs: 1000, fetch });

export function seededCache(slug: string, entry: { visibility: string; at: number }): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(tmpdir(), "jev-cache-"));
	mkdirSync(join(home, "agentic"), { recursive: true });
	writeFileSync(join(home, "agentic", "repo-visibility.json"), JSON.stringify({ [slug]: entry }));
	return { XDG_CACHE_HOME: home, TYPESAFE_API_KEY: "test-key" };
}
