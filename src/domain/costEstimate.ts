import { formatRub, netKop, parseRub, type Money } from "./money";

export type ExpenseCategory = "fuel" | "driver" | "tolls" | "carrier" | "downtime" | "return" | "other";

export const EXPENSE_LABELS: Record<ExpenseCategory, string> = {
  fuel: "Топливо",
  driver: "Водитель",
  tolls: "Платные дороги",
  carrier: "Подрядчик",
  downtime: "Простой",
  return: "Возврат",
  other: "Прочее",
};

export type TollState = { kind: "unknown" } | { kind: "none" } | { kind: "amount"; kop: number };

export type FormRead<T> = ({ ok: true } & T) | { ok: false; message: string };

/** The toll choice of a form. An amount that cannot be read is an error: it is never taken as zero rubles. */
export function readToll(kind: TollState["kind"], rub: string): FormRead<{ toll: TollState }> {
  if (kind !== "amount") return { ok: true, toll: { kind } };
  const kop = parseRub(rub);
  if (kop == null || kop < 0) return { ok: false, message: "Сумма платных дорог — неотрицательное число в рублях, например 1500 или 1500,50" };
  return { ok: true, toll: { kind: "amount", kop } };
}

/** Other costs of a form: an empty field means there are none; anything else must be a number of rubles. */
export function readOtherCost(rub: string): FormRead<{ kop: number }> {
  if (!rub.trim()) return { ok: true, kop: 0 };
  const kop = parseRub(rub);
  if (kop == null || kop < 0) return { ok: false, message: "Прочие расходы — неотрицательное число в рублях, например 200 или 200,50" };
  return { ok: true, kop };
}

export type CostLine = {
  category: ExpenseCategory;
  /** null when the amount is not known; it is never counted as zero. */
  kop: number | null;
  /** True when the figure comes from a norm or a rate, not from a document. */
  isEstimate: boolean;
};

export type CostEstimate = {
  lines: CostLine[];
  /** Sum of the known lines. */
  totalKop: number;
  /** True when some line is unknown, so the total is a lower bound. */
  incomplete: boolean;
  assumptions: string[];
};

function summarize(lines: CostLine[], assumptions: string[]): CostEstimate {
  return {
    lines,
    totalKop: lines.reduce((sum, l) => sum + (l.kop ?? 0), 0),
    incomplete: lines.some((l) => l.kop === null),
    assumptions,
  };
}

export type OwnFleetInput = {
  distanceM: number;
  tripDurationS: number;
  fuelNormLPer100Km: number | null;
  fuelPriceKopPerL: number;
  driverHourKop: number;
  toll: TollState;
  otherKop: number;
};

const oneDecimal = (n: number) => n.toFixed(1).replace(".", ",");

/** Cost of a trip by the company's own truck, from fuel norm and driver time. */
export function estimateOwn(i: OwnFleetInput): CostEstimate {
  const assumptions: string[] = [];
  const lines: CostLine[] = [];

  if (i.fuelNormLPer100Km == null) {
    lines.push({ category: "fuel", kop: null, isEstimate: true });
    assumptions.push("Норма расхода топлива у машины не задана");
  } else {
    const litres = (i.distanceM / 1000) * (i.fuelNormLPer100Km / 100);
    lines.push({ category: "fuel", kop: Math.round(litres * i.fuelPriceKopPerL), isEstimate: true });
    assumptions.push(`Топливо: ${i.fuelNormLPer100Km} л/100 км × ${formatRub(i.fuelPriceKopPerL)}/л`);
  }

  const hours = i.tripDurationS / 3600;
  lines.push({ category: "driver", kop: Math.round(hours * i.driverHourKop), isEstimate: true });
  assumptions.push(`Водитель: ${oneDecimal(hours)} ч × ${formatRub(i.driverHourKop)}/ч`);

  if (i.toll.kind === "unknown") {
    lines.push({ category: "tolls", kop: null, isEstimate: false });
    assumptions.push("Стоимость платных участков неизвестна");
  } else {
    lines.push({ category: "tolls", kop: i.toll.kind === "none" ? 0 : i.toll.kop, isEstimate: false });
    assumptions.push(i.toll.kind === "none" ? "Платных участков нет" : "Платные дороги: сумма введена вручную");
  }

  if (i.otherKop > 0) lines.push({ category: "other", kop: i.otherKop, isEstimate: false });
  return summarize(lines, assumptions);
}

/** Cost of a trip by a carrier: the agreed rate on the net base plus expected downtime. */
export function estimateCarrier(i: { rate: Money; expectedDowntimeKop: number }): CostEstimate {
  const lines: CostLine[] = [{ category: "carrier", kop: netKop(i.rate), isEstimate: false }];
  const assumptions = [
    i.rate.vatIncluded
      ? `Ставка ${formatRub(i.rate.amountKop)} с НДС приведена к базе без НДС`
      : `Ставка ${formatRub(i.rate.amountKop)} без НДС`,
  ];
  if (i.expectedDowntimeKop > 0) {
    lines.push({ category: "downtime", kop: i.expectedDowntimeKop, isEstimate: true });
    assumptions.push(`Ожидаемый простой по условиям предложения: ${formatRub(i.expectedDowntimeKop)}`);
  }
  return summarize(lines, assumptions);
}
