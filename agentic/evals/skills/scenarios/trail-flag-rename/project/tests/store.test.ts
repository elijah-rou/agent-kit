import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save, totalKm } from "../src/store.ts";

test("entries round-trip through the save file", () => {
	const file = join(mkdtempSync(join(tmpdir(), "trail-")), "entries.json");
	save([{ date: "2026-09-28", km: 12.5 }], file);
	expect(load(file)).toEqual([{ date: "2026-09-28", km: 12.5 }]);
});

test("totals the distance", () => {
	expect(totalKm([{ date: "2026-09-27", km: 4 }, { date: "2026-09-28", km: 12.5 }])).toBe(16.5);
});
