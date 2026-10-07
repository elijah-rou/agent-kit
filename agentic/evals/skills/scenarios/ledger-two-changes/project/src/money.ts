/** Format an amount in cents as dollars, e.g. 123456 -> "$1,234.56". */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`amount must be whole cents, got ${cents}`);
  const dollars = (cents / 100).toFixed(2);
  const [whole, fraction] = dollars.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${fraction}`;
}
