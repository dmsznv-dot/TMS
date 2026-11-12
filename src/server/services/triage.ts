import { and, eq, inArray } from "drizzle-orm";
import { EXPENSE_LABELS } from "@/domain/costEstimate";
import { WINDOW_STATE_LABELS } from "@/domain/format";
import { formatRub } from "@/domain/money";
import { allows, requireCan, type Ctx } from "../auth/context";
import { accruals, importJobs, planVersions, tasks, trips } from "../db/schema";
import { listExpenses, listInvoices, listPayments } from "./finance";
import { loadTrip } from "./trips";

export type TriageKind =
  | "late_risk"
  | "late_fact"
  | "partial_acceptance"
  | "unlinked_expense"
  | "unbilled_surcharge"
  | "overdue_invoice"
  | "payment_needs_review"
  | "import_errors";

export type TriageItem = {
  kind: TriageKind;
  title: string;
  /** Where to go to deal with it. */
  href: string;
  dueAt: Date | null;
};

export const TRIAGE_LABELS: Record<TriageKind, string> = {
  late_risk: "План не успевает в окно",
  late_fact: "Опоздания по факту",
  partial_acceptance: "Недопоставки и отказы",
  import_errors: "Ошибки импорта",
  unlinked_expense: "Расходы без связи",
  unbilled_surcharge: "Доплаты без счёта",
  overdue_invoice: "Просроченные счета",
  payment_needs_review: "Платежи на проверку",
};

const RUNNING = ["in_progress", "completed"] as const;

/**
 * Everything that waits for a person: late arrivals, short deliveries,
 * expenses without a trip, surcharges not yet invoiced, overdue invoices,
 * payments nobody has allocated, and import rows that did not go in. Money
 * items need money access; import errors need the right to import.
 */
export async function getTriage(ctx: Ctx): Promise<TriageItem[]> {
  requireCan(ctx, "trips.read");
  const items: TriageItem[] = [];

  // Plans that miss or risk a window.
  const plans = await ctx.db
    .select({ id: trips.id, number: trips.number, stops: planVersions.stopsSnapshot })
    .from(planVersions)
    .innerJoin(trips, eq(trips.id, planVersions.tripId))
    .where(and(eq(planVersions.orgId, ctx.orgId), eq(planVersions.isCurrent, true), inArray(trips.status, ["planned", "assigned"])));
  for (const plan of plans) {
    const worst = plan.stops
      .filter((s) => s.windowState === "risk" || s.windowState === "late")
      .sort((a, b) => b.lateMin - a.lateMin || (a.windowState === "late" ? -1 : 1))[0];
    if (!worst) continue;
    const late = worst.windowState === "late" ? ` на ${worst.lateMin} мин` : "";
    items.push({
      kind: "late_risk",
      title: `Рейс ${plan.number}: «${worst.locationName}» — ${WINDOW_STATE_LABELS[worst.windowState]}${late}`,
      href: `/trips/${plan.id}`,
      dueAt: worst.windowEnd ? new Date(worst.windowEnd) : null,
    });
  }

  // Stops reached after their window closed.
  const running = await ctx.db
    .select({ id: trips.id })
    .from(trips)
    .where(and(eq(trips.orgId, ctx.orgId), inArray(trips.status, [...RUNNING])))
    .limit(200);
  for (const { id } of running) {
    const trip = await loadTrip(ctx, id);
    for (const stop of trip.stops) {
      if (!stop.windowEnd || !stop.actualArriveAt || stop.actualArriveAt <= stop.windowEnd) continue;
      const minutes = Math.ceil((stop.actualArriveAt.getTime() - stop.windowEnd.getTime()) / 60_000);
      items.push({
        kind: "late_fact",
        title: `Рейс ${trip.number}: опоздание на ${minutes} мин к «${stop.location.name}»`,
        href: `/trips/${id}?tab=execution`,
        dueAt: stop.windowEnd,
      });
    }
  }

  // Short deliveries, rejections and returns that nobody has closed.
  const open = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.status, "open"), inArray(tasks.type, ["shortfall", "rejection", "return"])));
  for (const t of open) {
    items.push({ kind: "partial_acceptance", title: t.title, href: t.tripId ? `/trips/${t.tripId}?tab=acceptance` : "/trips", dueAt: t.dueAt });
  }

  if (allows(ctx, "planning.write")) {
    const jobs = await ctx.db.select().from(importJobs).where(eq(importJobs.orgId, ctx.orgId));
    for (const job of jobs) {
      const errors = job.counts?.errors ?? 0;
      if (job.status === "failed") {
        items.push({ kind: "import_errors", title: `Файл ${job.filename}: обработка прервалась`, href: `/import/${job.id}`, dueAt: null });
      } else if (job.status === "done" && errors > 0) {
        items.push({ kind: "import_errors", title: `Файл ${job.filename}: строк с ошибками — ${errors}`, href: `/import/${job.id}`, dueAt: null });
      }
    }
  }

  if (allows(ctx, "money.read")) {
    for (const e of await listExpenses(ctx, { unlinked: true })) {
      items.push({ kind: "unlinked_expense", title: `Расход без связи: ${EXPENSE_LABELS[e.category]}, ${formatRub(e.amountKop)}`, href: "/money", dueAt: null });
    }

    const surcharges = await ctx.db
      .select({ a: accruals, tripNumber: trips.number })
      .from(accruals)
      .innerJoin(trips, eq(trips.id, accruals.tripId))
      .where(and(eq(accruals.orgId, ctx.orgId), eq(accruals.kind, "surcharge"), eq(accruals.state, "agreed")));
    for (const { a, tripNumber } of surcharges) {
      items.push({
        kind: "unbilled_surcharge",
        title: `Доплата без счёта: ${a.description} — ${formatRub(a.amountKop)} (рейс ${tripNumber})`,
        href: `/trips/${a.tripId}?tab=money`,
        dueAt: null,
      });
    }

    for (const i of await listInvoices(ctx, { openOnly: true })) {
      if (!i.overdue) continue;
      items.push({
        kind: "overdue_invoice",
        title: `Просроченный счёт № ${i.number}: ${i.counterpartyName}, остаток ${formatRub(i.remainingKop)}`,
        href: "/money",
        dueAt: i.dueDate,
      });
    }

    for (const p of await listPayments(ctx)) {
      if (p.state !== "needs_review") continue;
      items.push({ kind: "payment_needs_review", title: `Платёж ${formatRub(p.amountKop)} от ${p.counterpartyName} требует проверки`, href: "/money", dueAt: null });
    }
  }

  const order = Object.keys(TRIAGE_LABELS);
  return items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
