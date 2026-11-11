/**
 * Money is kept as whole kopecks. VAT rates are basis points: 22 % = 2200.
 * Calculations across the service use the net (VAT-exclusive) base.
 */
export type Money = {
  amountKop: number;
  vatIncluded: boolean;
  vatRateBp: number;
};

const BP = 10_000n;

/** Integer division rounding half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (2n * abs + denominator) / (2n * denominator);
  return negative ? -rounded : rounded;
}

/** Amount without VAT, in kopecks. */
export function netKop(m: Money): number {
  if (!m.vatIncluded) return m.amountKop;
  return Number(divRound(BigInt(m.amountKop) * BP, BP + BigInt(m.vatRateBp)));
}

/** Amount with VAT, in kopecks. */
export function grossKop(m: Money): number {
  if (m.vatIncluded) return m.amountKop;
  return Number(divRound(BigInt(m.amountKop) * (BP + BigInt(m.vatRateBp)), BP));
}

/**
 * Parses rubles typed by a person: "1 234,56", "1234.5", "41000".
 * Returns kopecks, or null when the text is not an amount.
 */
export function parseRub(text: string): number | null {
  const compact = text.replace(/[\s  ]/g, "").replace("−", "-");
  const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(compact);
  if (!match) return null;
  const [, sign, rubles, fraction = ""] = match;
  const kop = Number(rubles) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(kop)) return null;
  return sign ? -kop : kop;
}

/** "35 500,00 ₽" */
export function formatRub(kop: number): string {
  const abs = Math.abs(kop);
  const rubles = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const fraction = (abs % 100).toString().padStart(2, "0");
  return `${kop < 0 ? "−" : ""}${rubles},${fraction} ₽`;
}
