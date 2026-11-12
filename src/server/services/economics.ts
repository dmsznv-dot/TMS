import { and, eq } from "drizzle-orm";
import type { ExpenseCategory } from "@/domain/costEstimate";
import { allocateByWeight, fleetOverheadKop, orderMarginKop, tripResult, type ExpenseLine, type TripResult } from "@/domain/economics";
import { netKop } from "@/domain/money";
import { formatInTz } from "@/domain/time";
import { requireCan, type Ctx } from "../auth/context";
import { accruals, orderLines, orders, tripCargo } from "../db/schema";
import { measuringPlan } from "./completenessData";
import { listExpenses, listInvoices, type ExpenseView, type InvoiceView } from "./finance";
import { getOrgSettings } from "./users";
import { loadTrip } from "./trips";

export type AccrualView = {
  id: string;
  kind: "revenue" | "surcharge";
  description: string;
  amountKop: number;
  netKop: number;
  vatIncluded: boolean;
  state: "agreed" | "invoiced";
};

export type DeliveryShare = { orderId: string; orderNumber: string; shareKop: number | null; marginKop: number | null };

export type TripEconomicsView = {
  tripId: string;
  /** Which plan the trip is measured against. */
  basis: "baseline" | "current" | "none";
  planVersionId: string | null;
  revenueKop: number | null;
  surchargesKop: number;
  /** Planned against actual, on the net (VAT-exclusive) base. */
  result: TripResult;
  unknownCategories: ExpenseCategory[];
  /** Plan and actual per category; null where the figure is unknown or not yet entered. */
  categories: { category: ExpenseCategory; planKop: number | null; factKop: number | null }[];
  /** Planned categories with no actual line at all, so the screen can offer "did not occur". */
  missingFact: ExpenseCategory[];
  /** Each deviation with the actual expenses it is made of, to open the source data. */
  deviation: { category: ExpenseCategory; kop: number; expenseIds: string[] }[];
  fleet: { rule: "days" | "km"; plan: number | null; fact: number | null };
  delivery: {
    allocationBase: "pallets" | "weight";
    costSource: "fact" | "plan";
    /** The delivery cost before it is spread over orders. */
    totalKop: number;
    orders: DeliveryShare[];
    /** Orders that have no pallets or weight, so nothing can be spread. */
    missing: string[];
  };
  expenses: ExpenseView[];
  accruals: AccrualView[];
  invoices: InvoiceView[];
  /** What is still owed, kept apart from the result. */
  debt: { receivableKop: number; payableKop: number };
};

const DAY_MS = 86_400_000;

/** Calendar days in a zone from the day of `start` to the day of `end`, both counted. */
function calendarDays(start: Date, end: Date, tz: string): number {
  const parts = (d: Date) => formatInTz(d, tz, "yyyy-MM-dd").split("-").map(Number);
  const [y1, m1, d1] = parts(start);
  const [y2, m2, d2] = parts(end);
  return Math.max(1, Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS) + 1);
}

/**
 * Economics of a trip: plan against actual with the deviation explained,
 * fleet overhead, delivery cost spread over orders, and the debt shown
 * separately. Plan lines come from the baseline plan; expenses are the facts.
 */
export async function getTripEconomics(ctx: Ctx, tripId: string): Promise<TripEconomicsView> {
  requireCan(ctx, "money.read");
  const trip = await loadTrip(ctx, tripId);
  const settings = await getOrgSettings(ctx);
  const plan = await measuringPlan(ctx, trip);
  const tz = trip.stops[0].location.tz;

  const expenseViews = await listExpenses(ctx, { tripId });
  const accrualRows = await ctx.db.select().from(accruals).where(and(eq(accruals.tripId, tripId), eq(accruals.orgId, ctx.orgId)));
  const accrualViews = accrualRows.map(
    (a): AccrualView => ({
      id: a.id,
      kind: a.kind,
      description: a.description,
      amountKop: a.amountKop,
      netKop: netKop({ amountKop: a.amountKop, vatIncluded: a.vatIncluded, vatRateBp: a.vatRateBp }),
      vatIncluded: a.vatIncluded,
      state: a.state,
    }),
  );
  const revenues = accrualViews.filter((a) => a.kind === "revenue");
  const revenueKop = revenues.length > 0 ? revenues.reduce((s, a) => s + a.netKop, 0) : null;
  const surchargesKop = accrualViews.filter((a) => a.kind === "surcharge").reduce((s, a) => s + a.netKop, 0);

  const planLines: ExpenseLine[] = (plan?.costLines ?? []).map((l) => ({ category: l.category, kop: l.kop }));
  const factLines: ExpenseLine[] = expenseViews.map((e) => ({ category: e.category, kop: e.netKop }));

  // Fleet overhead: days and kilometres, planned and actual.
  const planStops = plan?.stopsSnapshot ?? [];
  const planDays =
    planStops.length > 0 ? calendarDays(new Date(planStops[0].departAt), new Date(planStops[planStops.length - 1].departAt), tz) : 1;
  const first = trip.stops[0];
  const last = trip.stops[trip.stops.length - 1];
  const factStart = first.actualDepartAt ?? first.actualArriveAt;
  const factEnd = last.actualDepartAt ?? last.actualArriveAt;
  // Until the trip has actual times its days are taken from the plan.
  const factDays = factStart && factEnd ? calendarDays(factStart, factEnd, tz) : planDays;
  const planKm = plan ? plan.distanceM / 1000 : null;
  const fleetPlan = fleetOverheadKop(settings.fleetRule, settings.fleetRateKop, { days: planDays, km: planKm });
  const fleetFact = fleetOverheadKop(settings.fleetRule, settings.fleetRateKop, { days: factDays, km: trip.mileageKm });

  const result = tripResult({ revenueKop, surchargesKop, plan: planLines, fact: factLines, fleetPlanKop: fleetPlan, fleetFactKop: fleetFact });

  const sumOf = (lines: ExpenseLine[], category: ExpenseCategory) => {
    const own = lines.filter((l) => l.category === category);
    if (own.length === 0) return undefined;
    return own.some((l) => l.kop === null) ? null : own.reduce((s, l) => s + (l.kop ?? 0), 0);
  };
  const ORDER: ExpenseCategory[] = ["fuel", "driver", "tolls", "carrier", "downtime", "return", "other"];
  const categories = ORDER.flatMap((category) => {
    const p = sumOf(planLines, category);
    const f = sumOf(factLines, category);
    if (p === undefined && f === undefined) return [];
    return [{ category, planKop: p === undefined ? 0 : p, factKop: f === undefined ? null : f }];
  });
  const missingFact = categories.filter((c) => sumOf(planLines, c.category) !== undefined && sumOf(factLines, c.category) === undefined).map((c) => c.category);

  const deviation = result.deviation.map((d) => ({
    ...d,
    expenseIds: expenseViews.filter((e) => e.category === d.category).map((e) => e.id),
  }));

  // Delivery cost over orders, by pallets or weight of what this trip carries to each.
  const cargo = await ctx.db
    .select({
      qty: tripCargo.qtyMilli,
      lineQty: orderLines.qtyMilli,
      pallets: orderLines.palletsMilli,
      weight: orderLines.weightKgMilli,
      price: orderLines.priceKop,
      cost: orderLines.costKop,
      orderId: orders.id,
      orderNumber: orders.number,
    })
    .from(tripCargo)
    .innerJoin(orderLines, eq(orderLines.id, tripCargo.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(eq(tripCargo.tripId, tripId), eq(tripCargo.orgId, ctx.orgId)));

  const byOrder = new Map<string, { number: string; weight: number; lines: { qty: number; priceKop: number | null; costKop: number | null }[] }>();
  for (const c of cargo) {
    const base = settings.deliveryAllocBase === "pallets" ? c.pallets : c.weight;
    const entry = byOrder.get(c.orderId) ?? { number: c.orderNumber, weight: 0, lines: [] };
    entry.weight += (c.qty / c.lineQty) * ((base ?? 0) / 1000);
    entry.lines.push({ qty: c.qty, priceKop: c.price, costKop: c.cost });
    byOrder.set(c.orderId, entry);
  }

  const costSource = expenseViews.length > 0 ? "fact" : "plan";
  const totalKop = costSource === "fact" ? result.fact.directKop : result.plan.directKop;
  const parts = [...byOrder].map(([id, o]) => ({ id, weight: o.weight }));
  const shares = allocateByWeight(totalKop, parts);
  const shareOf = new Map(shares?.map((s) => [s.id, s.kop]));

  const invoiceViews = await listInvoices(ctx, { tripId });
  const sumRemaining = (direction: "out" | "in") => invoiceViews.filter((i) => i.direction === direction).reduce((s, i) => s + i.remainingKop, 0);

  return {
    tripId,
    basis: !plan ? "none" : trip.baselinePlanVersionId ? "baseline" : "current",
    planVersionId: plan?.id ?? null,
    revenueKop,
    surchargesKop,
    result,
    unknownCategories: result.unknownCategories,
    categories,
    missingFact,
    deviation,
    fleet: { rule: settings.fleetRule, plan: fleetPlan, fact: fleetFact },
    delivery: {
      allocationBase: settings.deliveryAllocBase,
      costSource,
      totalKop,
      orders: [...byOrder].map(([id, o]) => {
        const share = shareOf.get(id) ?? null;
        return {
          orderId: id,
          orderNumber: o.number,
          shareKop: share,
          marginKop: share === null ? null : orderMarginKop(o.lines, share),
        };
      }),
      missing: [...byOrder].filter(([, o]) => !(o.weight > 0)).map(([, o]) => o.number),
    },
    expenses: expenseViews,
    accruals: accrualViews,
    invoices: invoiceViews,
    debt: { receivableKop: sumRemaining("out"), payableKop: sumRemaining("in") },
  };
}
