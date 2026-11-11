import { and, eq, isNull, sql } from "drizzle-orm";
import type { CompletenessInput } from "@/domain/completeness";
import type { ExpenseCategory } from "@/domain/costEstimate";
import { DomainError } from "@/domain/errors";
import type { Ctx } from "../auth/context";
import { accruals, acceptances, expenses, planVersions, tasks, tripCargo, trips } from "../db/schema";

/** The plan a trip is measured against: the one fixed at first assignment, else the current one. */
export async function measuringPlan(ctx: Ctx, trip: { id: string; baselinePlanVersionId: string | null }) {
  const [plan] = trip.baselinePlanVersionId
    ? await ctx.db.select().from(planVersions).where(eq(planVersions.id, trip.baselinePlanVersionId))
    : await ctx.db
        .select()
        .from(planVersions)
        .where(and(eq(planVersions.tripId, trip.id), eq(planVersions.orgId, ctx.orgId), eq(planVersions.isCurrent, true)));
  return plan ?? null;
}

/** Reads what the completeness check needs. It does not decide anything. */
export async function gatherCompleteness(ctx: Ctx, tripId: string): Promise<CompletenessInput> {
  const [trip] = await ctx.db
    .select({ id: trips.id, baselinePlanVersionId: trips.baselinePlanVersionId, mileageKm: trips.mileageKm, mileageUnknown: trips.mileageUnknown })
    .from(trips)
    .where(and(eq(trips.id, tripId), eq(trips.orgId, ctx.orgId)));
  if (!trip) throw new DomainError("not_found", "Рейс не найден");

  const [{ n: withoutAcceptance }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(tripCargo)
    .leftJoin(acceptances, and(eq(acceptances.tripCargoId, tripCargo.id), eq(acceptances.isCurrent, true)))
    .where(and(eq(tripCargo.tripId, tripId), eq(tripCargo.orgId, ctx.orgId), isNull(acceptances.id)));

  const plan = await measuringPlan(ctx, trip);
  const planned = new Set<ExpenseCategory>((plan?.costLines ?? []).map((l) => l.category));

  const expenseRows = await ctx.db
    .select({ category: expenses.category, check: expenses.checkStatus })
    .from(expenses)
    .where(and(eq(expenses.tripId, tripId), eq(expenses.orgId, ctx.orgId)));
  const withFact = new Set(expenseRows.map((e) => e.category));

  const [{ n: unbilled }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(accruals)
    .where(and(eq(accruals.tripId, tripId), eq(accruals.orgId, ctx.orgId), eq(accruals.kind, "surcharge"), eq(accruals.state, "agreed")));

  const [{ n: openTasks }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.tripId, tripId), eq(tasks.orgId, ctx.orgId), eq(tasks.status, "open")));

  return {
    cargoWithoutAcceptance: withoutAcceptance,
    mileageKnownOrMarked: trip.mileageKm !== null || trip.mileageUnknown,
    planCategoriesWithoutFact: [...planned].filter((c) => !withFact.has(c)),
    unverifiedExpenses: expenseRows.filter((e) => e.check === "unverified").length,
    unbilledSurcharges: unbilled,
    openTasks,
  };
}
