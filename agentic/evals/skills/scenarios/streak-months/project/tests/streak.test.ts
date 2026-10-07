import { expect, test } from "bun:test";
import { currentStreak } from "../src/streak.ts";

test("counts consecutive days ending today", () => {
	expect(currentStreak(["2026-09-10", "2026-09-11", "2026-09-12"], "2026-09-12")).toBe(3);
});

test("a streak ending yesterday still counts", () => {
	expect(currentStreak(["2026-09-10", "2026-09-11"], "2026-09-12")).toBe(2);
});

test("a gap ends the streak", () => {
	expect(currentStreak(["2026-09-08", "2026-09-10", "2026-09-11"], "2026-09-11")).toBe(2);
});

test("no recent entries means no streak", () => {
	expect(currentStreak(["2026-09-01"], "2026-09-12")).toBe(0);
});
