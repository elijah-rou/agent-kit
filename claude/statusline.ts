#!/usr/bin/env bun
// Renders the quota data Claude supplies on stdin; never reads credentials or calls provider APIs.

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

export function render(raw: Uint8Array, now: number): string {
  if (raw.length > MAX_INPUT_BYTES) return UNKNOWN;
  try {
    return formatStatusline(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), now);
  } catch {
    return UNKNOWN;
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
  console.log(render(raw, Math.floor(Date.now() / 1000)));
}
