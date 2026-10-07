import type { Transaction } from "./ledger.ts";
import { formatCents } from "./money.ts";

export function monthlyReport(month: string, transactions: Transaction[]): string {
  const byCategory = new Map<string, number>();
  for (const t of transactions) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.cents);
  const lines = [`Report for ${month}`, ""];
  for (const [category, cents] of [...byCategory].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`${category.padEnd(14)}${formatCents(cents).padStart(12)}`);
  }
  const net = transactions.reduce((sum, t) => sum + t.cents, 0);
  lines.push("", `${"Net".padEnd(14)}${formatCents(net).padStart(12)}`);
  return lines.join("\n");
}
