// Native quota rendering, including unknown and stale provider data.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { formatStatusline } from "../statusline.ts";

const SCRIPT = join(import.meta.dir, "../statusline.ts");
const NOW = 1_790_000_000;
const five = (used: unknown, resets?: unknown) => ({ rate_limits: { five_hour: resets === undefined ? { used_percentage: used } : { used_percentage: used, resets_at: resets } } });

test("gauges, percentages, and reset countdowns", () => {
  expect(formatStatusline({ rate_limits: { seven_day: { used_percentage: 3, resets_at: NOW + 46 * 3600 } } }, NOW)).toBe("claude 7d ▁ 3% ↻1d22h");
  expect(formatStatusline({ rate_limits: { five_hour: { used_percentage: 25, resets_at: NOW + 2 * 3600 + 14 * 60 }, seven_day: { used_percentage: 3 } } }, NOW)).toBe("claude 5h ▃ 25% ↻2h14m · 7d ▁ 3%");
  for (const [percent, expected] of [[0, "▁ 0%"], [100, "█ 100%"], [50.5, "▅ 51%"]] as const) expect(formatStatusline(five(percent), NOW)).toBe(`claude 5h ${expected}`);
  for (const [seconds, expected] of [[0.5, "<1m"], [1.5, "<1m"], [1, "<1m"], [59, "<1m"], [60, "1m"], [3599, "59m"], [3600, "1h0m"], [86399, "23h59m"], [86400, "1d"], [90000, "1d1h"]] as const) {
    expect(formatStatusline(five(3, NOW + seconds), NOW).endsWith(`↻${expected}`)).toBe(true);
  }
});

test("invalid or stale data shows n/a, never zero usage", () => {
  for (const invalid of [null, true, false, "3", [], {}, -0.01, 100.01, NaN, Infinity, -Infinity]) expect(formatStatusline(five(invalid), NOW)).toBe("claude limits: n/a");
  for (const invalid of [null, true, "later", [], {}, -1, 0, NaN, Infinity]) expect(formatStatusline(five(3, invalid), NOW)).toBe("claude 5h ▁ 3%");
  for (const seconds of [-1, 0]) expect(formatStatusline(five(3, NOW + seconds), NOW)).toBe("claude limits: n/a");
  for (const value of [null, {}, [], false, "wrong", 1, { rate_limits: null }, { rate_limits: [] }, { rate_limits: { five_hour: null } }, { rate_limits: { five_hour: [] } }]) {
    expect(formatStatusline(value, NOW)).toBe("claude limits: n/a");
  }
});

test("the command reads bounded stdin and always prints a line", () => {
  const inputs = ["", "not json", "null", "[]", "true", '{"rate_limits":{}}', "x".repeat(65_537)].map(text => Buffer.from(text));
  inputs.push(Buffer.from([0xff]));
  for (const input of inputs) {
    const result = spawnSync("bun", [SCRIPT], { input, timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("claude limits: n/a");
  }
  const result = spawnSync("bun", [SCRIPT], { input: JSON.stringify({ rate_limits: { seven_day: { used_percentage: 3 } } }), timeout: 5000 });
  expect(result.stdout.toString().trim()).toBe("claude 7d ▁ 3%");
});
