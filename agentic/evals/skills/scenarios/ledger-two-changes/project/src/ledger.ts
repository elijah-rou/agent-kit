export type Transaction = { date: string; description: string; category: string; cents: number };

export function parseCsv(text: string): Transaction[] {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  if (header !== "date,description,category,amount") throw new Error(`unexpected header: ${header}`);
  return rows.map((row, i) => {
    const [date, description, category, amount] = row.split(",");
    const cents = Number(amount);
    if (!date || !description || !category || !Number.isSafeInteger(cents)) throw new Error(`bad row ${i + 2}: ${row}`);
    return { date, description, category, cents };
  });
}

export function inMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((t) => t.date.startsWith(`${month}-`));
}
