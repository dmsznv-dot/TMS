import { and, eq, sql } from "drizzle-orm";
import type { TripFacts } from "@/domain/tripStatus";
import type { Ctx } from "../auth/context";
import { carrierOffers, planVersions, tripCargo, tripStops } from "../db/schema";

/**
 * What is currently true of a trip, gathered for the status rules.
 *
 * Execution events and financial completeness live in tables that later
 * modules add. Until a module extends this function its facts are false, so
 * the transitions that depend on them stay closed.
 */
export async function tripFacts(
  ctx: Ctx,
  tripId: string,
): Promise<Omit<TripFacts, "overrideReason" | "cancelReason">> {
  const [{ cargo }] = await ctx.db
    .select({ cargo: sql<number>`count(*)::int` })
    .from(tripCargo)
    .where(and(eq(tripCargo.tripId, tripId), eq(tripCargo.orgId, ctx.orgId)));

  const stops = await ctx.db
    .select({ arrive: tripStops.actualArriveAt, skipped: tripStops.skippedReason })
    .from(tripStops)
    .where(and(eq(tripStops.tripId, tripId), eq(tripStops.orgId, ctx.orgId)));

  const [plan] = await ctx.db
    .select({ executor: planVersions.executor, vehicleId: planVersions.vehicleId, driverId: planVersions.driverId, offerId: planVersions.carrierOfferId })
    .from(planVersions)
    .where(and(eq(planVersions.tripId, tripId), eq(planVersions.orgId, ctx.orgId), eq(planVersions.isCurrent, true)));

  let executorReady = false;
  if (plan?.executor === "own") executorReady = !!plan.vehicleId && !!plan.driverId;
  if (plan?.executor === "carrier" && plan.offerId) {
    const [offer] = await ctx.db.select({ status: carrierOffers.status }).from(carrierOffers).where(eq(carrierOffers.id, plan.offerId));
    executorReady = offer?.status === "confirmed";
  }

  return {
    hasCargoStops: cargo > 0,
    allStopsResolved: stops.length > 0 && stops.every((s) => s.arrive != null || (s.skipped ?? "").trim() !== ""),
    hasCurrentPlan: !!plan,
    executorReady,
    hasExecutionEvent: false,
    completenessOk: false,
  };
}
