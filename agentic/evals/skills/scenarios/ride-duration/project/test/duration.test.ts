import { describe, expect, test } from "bun:test";
import { formatDuration } from "../src/duration.ts";

describe("formatDuration", () => {
  test("under an hour shows minutes only", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45)).toBe("1m");
    expect(formatDuration(2290)).toBe("38m");
  });

  test("an hour or more shows hours and minutes", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(5400)).toBe("1h 30m");
  });

  test("rejects invalid input", () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(1.5)).toThrow(RangeError);
  });
});
