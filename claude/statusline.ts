#!/usr/bin/env bun
// Renders the quota data Claude supplies on stdin and records its seven-day window for `agentic quota
// pace`, which has no other source for it. Never reads credentials or calls provider APIs.

const MAX_INPUT_BYTES = 65_536;
const MAX_EPOCH_SECONDS = 2 ** 53 - 1;
const GAUGE = [..."▁▂▃▄▅▆▇█"];
const UNKNOWN = "claude limits: n/a";

const fields = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function resetCountdown(seconds: number): string {
  if (!(Number.isInteger(seconds) && seconds >= 0)) throw new Error("countdown needs whole non-negative seconds");
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`;
}

export function formatStatusline(data: unknown, now: number): string {
  if (!(Number.isInteger(now) && now >= 0)) throw new Error("now must be whole non-negative seconds");
  const limits = fields(fields(data)?.rate_limits);
  if (limits === undefined) return UNKNOWN;
  const parts: string[] = [];
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const window = fields(limits[key]);
    const percent = window?.used_percentage;
    if (window === undefined || !finite(percent) || percent < 0 || percent > 100) continue;
    const reset = window.resets_at;
    let resetText = "";
    if (finite(reset) && reset > 0 && reset <= MAX_EPOCH_SECONDS) {
      if (reset <= now) continue;
      resetText = ` ↻${resetCountdown(Math.floor(reset - now))}`;
    }
    const index = Math.floor((percent * (GAUGE.length - 1)) / 100 + 0.5);
    parts.push(`${label} ${GAUGE[index]} ${Math.floor(percent + 0.5)}%${resetText}`);
  }
  return parts.length > 0 ? `claude ${parts.join(" · ")}` : UNKNOWN;
}

function parseInput(raw: Uint8Array): unknown {
  if (raw.length > MAX_INPUT_BYTES) throw new Error("status line input is over the size limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
}

export function render(raw: Uint8Array, now: number): string {
  try {
    return formatStatusline(parseInput(raw), now);
  } catch {
    return UNKNOWN;
  }
}

/**
 * Records the seven-day window when Claude supplied a valid one. Any failure is dropped, the quota module's
 * loading included, since it is imported here: the status line matters more than the record.
 */
export async function recordWindow(raw: Uint8Array, now: number, env: Record<string, string | undefined>): Promise<void> {
  try {
    const { recordSnapshot, snapshotOf } = await import("../agentic/tools/quota/quota.ts");
    const snapshot = snapshotOf(parseInput(raw), now);
    if (snapshot !== undefined) recordSnapshot(snapshot, env);
  } catch {
    return;
  }
}

if (import.meta.main) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) break;
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  const now = Math.floor(Date.now() / 1000);
  console.log(render(raw, now));
  await recordWindow(raw, now, process.env);
}
