import { and, eq, sql } from "drizzle-orm";
import type { TripFacts } from "@/domain/tripStatus";
import type { Ctx } from "../auth/context";
import { carrierOffers, planVersions, tripCargo, tripEvents, tripStops } from "../db/schema";

/**
 * What is currently true of a trip, gathered for the status rules.
 *
 * Financial completeness lives in tables that a later module adds; until it
 * extends this function that fact is false, so closing stays closed.
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
    .select({ arrive: tripStops.actualArriveAt, depart: tripStops.actualDepartAt, skipped: tripStops.skippedReason })
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

  const [{ events }] = await ctx.db
    .select({ events: sql<number>`count(*)::int` })
    .from(tripEvents)
    .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.orgId, ctx.orgId)));

  return {
    hasCargoStops: cargo > 0,
    // A stop is resolved when the truck both arrived and left, or when it is marked as not happening.
    allStopsResolved:
      stops.length > 0 && stops.every((s) => (s.arrive != null && s.depart != null) || (s.skipped ?? "").trim() !== ""),
    hasCurrentPlan: !!plan,
    executorReady,
    hasExecutionEvent: events > 0,
    completenessOk: false,
  };
}
