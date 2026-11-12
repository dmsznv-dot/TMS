/** A quantity in thousandths of its unit: 1.5 pallets = 1500. */
export type QtyMilli = number;

/**
 * Parses a quantity from a file cell or a form field.
 * Returns null for negative values, text, or more than three decimals.
 */
export function parseQty(value: string | number): QtyMilli | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const milli = Math.round(value * 1000);
    if (Math.abs(value * 1000 - milli) > 1e-6) return null;
    return Number.isSafeInteger(milli) ? milli : null;
  }
  const compact = value.replace(/[\s  ]/g, "");
  const match = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(compact);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  return Number.isSafeInteger(milli) ? milli : null;
}

/** "1,5", "2", "0,001" */
export function formatQty(q: QtyMilli): string {
  const whole = Math.floor(q / 1000);
  const fraction = (q % 1000).toString().padStart(3, "0").replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fraction ? `${grouped},${fraction}` : grouped;
}
