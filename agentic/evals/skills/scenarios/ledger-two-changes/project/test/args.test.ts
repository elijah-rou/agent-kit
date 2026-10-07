import { expect, test } from "bun:test";
import { parseReportArgs } from "../src/args.ts";

test("parses month, output file, and input", () => {
  expect(parseReportArgs(["--month", "2026-09", "--out", "sep.txt", "data.csv"])).toEqual({
    month: "2026-09",
    outPath: "sep.txt",
    csvPath: "data.csv",
  });
});

test("output file is optional", () => {
  expect(parseReportArgs(["--month", "2026-09", "data.csv"]).outPath).toBeUndefined();
});

test("requires a month", () => {
  expect(() => parseReportArgs(["data.csv"])).toThrow("--month");
});

test("rejects unknown options", () => {
  expect(() => parseReportArgs(["--month", "2026-09", "--verbose", "data.csv"])).toThrow("unknown option");
});
