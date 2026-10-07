#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { parseReportArgs, usage } from "./args.ts";
import { inMonth, parseCsv } from "./ledger.ts";
import { monthlyReport } from "./report.ts";

const [command, ...rest] = process.argv.slice(2);
if (command !== "report") {
  console.error(usage);
  process.exit(2);
}
try {
  const args = parseReportArgs(rest);
  const report = monthlyReport(args.month, inMonth(parseCsv(readFileSync(args.csvPath, "utf8")), args.month));
  if (args.outPath) writeFileSync(args.outPath, `${report}\n`);
  else console.log(report);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
