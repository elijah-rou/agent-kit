export type ReportArgs = { month: string; outPath: string | undefined; csvPath: string };

export const usage = "usage: pocket-ledger report --month YYYY-MM [--out FILE] <transactions.csv>";

export function parseReportArgs(argv: string[]): ReportArgs {
  let month: string | undefined;
  let outPath: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--month") month = argv[++i];
    else if (arg === "--out") outPath = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n${usage}`);
    else positional.push(arg);
  }
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month YYYY-MM is required\n${usage}`);
  if (positional.length !== 1) throw new Error(usage);
  return { month, outPath, csvPath: positional[0]! };
}
