import { expect, test } from "bun:test";
import { formatCents } from "../src/money.ts";

test("formats whole and fractional dollars", () => {
  expect(formatCents(0)).toBe("$0.00");
  expect(formatCents(5)).toBe("$0.05");
  expect(formatCents(1250)).toBe("$12.50");
});

test("groups thousands", () => {
  expect(formatCents(123456)).toBe("$1,234.56");
  expect(formatCents(100000000)).toBe("$1,000,000.00");
});

test("rejects fractional cents", () => {
  expect(() => formatCents(1.5)).toThrow(RangeError);
});
