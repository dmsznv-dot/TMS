import type { ExpenseCategory } from "./costEstimate";
import type { QtyMilli } from "./qty";

/** One expense figure; null means the amount is not known, which is different from zero. */
export type ExpenseLine = { category: ExpenseCategory; kop: number | null };

export type Side = {
  /** Sum of the known direct expenses. */
  directKop: number;
  /** Revenue minus direct expenses; null while revenue is unknown. */
  marginKop: number | null;
  /** Margin minus fleet overhead; null while either is unknown. */
  afterFleetKop: number | null;
  /** True when some expense is unknown, so the figures are lower bounds. */
  incomplete: boolean;
};

const ORDER: ExpenseCategory[] = ["fuel", "driver", "tolls", "carrier", "downtime", "return", "other"];

type Aggregate = { known: number; hasUnknown: boolean };

function aggregate(lines: ExpenseLine[]): Map<ExpenseCategory, Aggregate> {
  const map = new Map<ExpenseCategory, Aggregate>();
  for (const line of lines) {
    const entry = map.get(line.category) ?? { known: 0, hasUnknown: false };
    if (line.kop === null) entry.hasUnknown = true;
    else entry.known += line.kop;
    map.set(line.category, entry);
  }
  return map;
}

export type TripResultInput = {
  /** Revenue for carrying the trip; null when it is not known. */
  revenueKop: number | null;
  /** Agreed surcharges; they count in the actual result only. */
  surchargesKop: number;
  plan: ExpenseLine[];
  fact: ExpenseLine[];
  fleetPlanKop: number | null;
  fleetFactKop: number | null;
};

export type TripResult = {
  plan: Side;
  fact: Side;
  /** Actual minus planned per category, only where both are known and differ. */
  deviation: { category: ExpenseCategory; kop: number }[];
  deviationTotalKop: number;
  /** Categories whose deviation cannot be given because a plan or an actual figure is unknown. */
  unknownCategories: ExpenseCategory[];
};

/**
 * Result of a trip, planned against actual, with the deviation explained by
 * category. A planned category with no actual line is unknown until someone
 * enters the amount or marks that it did not occur (a zero line).
 */
export function tripResult(i: TripResultInput): TripResult {
  const plan = aggregate(i.plan);
  const fact = aggregate(i.fact);

  const deviation: TripResult["deviation"] = [];
  const unknownCategories: ExpenseCategory[] = [];
  let factIncomplete = false;
  let planIncomplete = false;

  for (const category of ORDER) {
    const p = plan.get(category);
    const f = fact.get(category);
    if (!p && !f) continue;

    const planUnknown = !!p?.hasUnknown;
    const factUnknown = f ? f.hasUnknown : !!p; // planned but no actual line yet
    if (planUnknown) planIncomplete = true;
    if (factUnknown) factIncomplete = true;
    if (planUnknown || factUnknown) {
      unknownCategories.push(category);
      continue;
    }
    const delta = (f?.known ?? 0) - (p?.known ?? 0);
    if (delta !== 0) deviation.push({ category, kop: delta });
  }

  const sum = (m: Map<ExpenseCategory, Aggregate>) => [...m.values()].reduce((s, a) => s + a.known, 0);
  const side = (direct: number, revenue: number | null, fleet: number | null, incomplete: boolean): Side => {
    const margin = revenue === null ? null : revenue - direct;
    return { directKop: direct, marginKop: margin, afterFleetKop: margin === null || fleet === null ? null : margin - fleet, incomplete };
  };

  return {
    plan: side(sum(plan), i.revenueKop, i.fleetPlanKop, planIncomplete),
    fact: side(sum(fact), i.revenueKop === null ? null : i.revenueKop + i.surchargesKop, i.fleetFactKop, factIncomplete),
    deviation,
    deviationTotalKop: deviation.reduce((s, d) => s + d.kop, 0),
    unknownCategories,
  };
}

/**
 * Fleet overhead charged to one trip: a daily rate for the days it takes,
 * or a rate per kilometre of actual mileage (unknown without mileage).
 */
export function fleetOverheadKop(rule: "days" | "km", rateKop: number, i: { days: number; km: number | null }): number | null {
  if (rule === "days") return rateKop * i.days;
  return i.km === null ? null : Math.round(rateKop * i.km);
}

/**
 * Spreads an amount over parts in proportion to their weights. The parts
 * add up to the total: the rounding remainder goes to the largest weight
 * (the first of equals). Null when there is nothing to spread over or a
 * weight is not positive.
 */
export function allocateByWeight(totalKop: number, parts: { id: string; weight: number }[]): { id: string; kop: number }[] | null {
  if (parts.length === 0 || parts.some((p) => !(p.weight > 0))) return null;
  const sum = parts.reduce((s, p) => s + p.weight, 0);
  const shares = parts.map((p) => ({ id: p.id, kop: Math.floor((totalKop * p.weight) / sum) }));
  const remainder = totalKop - shares.reduce((s, p) => s + p.kop, 0);
  if (remainder !== 0) {
    let largest = 0;
    parts.forEach((p, idx) => {
      if (p.weight > parts[largest].weight) largest = idx;
    });
    shares[largest].kop += remainder;
  }
  return shares;
}

/** Margin of an order: selling price minus cost of goods per line, minus the delivery cost. */
export function orderMarginKop(
  lines: { qty: QtyMilli; priceKop: number | null; costKop: number | null }[],
  deliveryKop: number,
): number | null {
  if (lines.length === 0) return null;
  let total = 0;
  for (const line of lines) {
    if (line.priceKop === null || line.costKop === null) return null;
    total += Math.round(((line.priceKop - line.costKop) * line.qty) / 1000);
  }
  return total - deliveryKop;
}
