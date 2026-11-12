"use server";

import { zonedToUtc } from "@/domain/time";
import type { TollState } from "@/domain/costEstimate";
import type { TripStatus } from "@/domain/tripStatus";
import {
  assignTrip,
  calculateRoutes,
  listExecutorOptions,
  savePlan,
  type CalculateResult,
  type ExcludedVehicle,
  type ExecutorOptionRow,
} from "@/server/services/planning";
import { addCarrierOffer, setOfferStatus, type OfferStatus } from "@/server/services/offers";
import { addOrderToTrip, createTrip, getTrip, removeCargo, reorderStops, transitionTrip } from "@/server/services/trips";
import type { UserCtx } from "@/server/auth/requireCtx";
import { run, type ActionResult } from "./run";

const PAGES = ["/planning", "/trips"];

/** Departure is typed as wall-clock time at the loading point; this makes it an instant. */
async function departureOf(ctx: UserCtx, tripId: string, local: string): Promise<Date> {
  const trip = await getTrip(ctx, tripId);
  return zonedToUtc(local, trip.stops[0].location.tz);
}

export async function createTripAction(originLocationId: string): Promise<ActionResult<{ tripId: string }>> {
  return run((ctx) => createTrip(ctx, { originLocationId }), PAGES);
}

export async function addToTripAction(
  tripId: string,
  expectedVersion: number,
  items: { orderLineId: string; qtyMilli: number }[],
): Promise<ActionResult<{ version: number }>> {
  return run((ctx) => addOrderToTrip(ctx, { tripId, expectedVersion, items }), PAGES);
}

export async function removeCargoAction(tripId: string, expectedVersion: number, tripCargoId: string): Promise<ActionResult<{ version: number }>> {
  return run((ctx) => removeCargo(ctx, { tripId, expectedVersion, tripCargoId }), PAGES);
}

export async function reorderStopsAction(tripId: string, expectedVersion: number, stopIds: string[]): Promise<ActionResult<{ version: number }>> {
  return run((ctx) => reorderStops(ctx, { tripId, expectedVersion, stopIds }), PAGES);
}

export async function cancelTripAction(tripId: string, expectedVersion: number, reason: string): Promise<ActionResult<{ version: number }>> {
  return run((ctx) => transitionTrip(ctx, { tripId, expectedVersion, to: "cancelled" as TripStatus, cancelReason: reason }), PAGES);
}

export async function calculateAction(input: {
  tripId: string;
  departureLocal: string;
  vehicleId: string | null;
  avoidToll: boolean;
  confirmFar: boolean;
}): Promise<ActionResult<CalculateResult>> {
  return run(async (ctx) =>
    calculateRoutes(ctx, {
      tripId: input.tripId,
      departureAt: await departureOf(ctx, input.tripId, input.departureLocal),
      vehicleId: input.vehicleId,
      avoidToll: input.avoidToll,
      confirmFar: input.confirmFar,
    }),
  );
}

export async function optionsAction(input: {
  tripId: string;
  departureLocal: string;
  variants: { token: string; toll: TollState; otherKop: number }[];
}): Promise<ActionResult<{ rows: ExecutorOptionRow[]; excluded: ExcludedVehicle[] }>> {
  return run(async (ctx) =>
    listExecutorOptions(ctx, {
      tripId: input.tripId,
      departureAt: await departureOf(ctx, input.tripId, input.departureLocal),
      variants: input.variants,
    }),
  );
}

export async function savePlanAction(input: {
  tripId: string;
  expectedVersion: number;
  reason: string | null;
  departureLocal: string;
  executor: { kind: "own"; vehicleId: string; driverId: string } | { kind: "carrier"; offerId: string };
  route: { kind: "sealed"; token: string } | { kind: "manual"; distanceM: number; durationS: number };
  toll: TollState;
  otherKop: number;
}): Promise<ActionResult<{ planVersionId: string; versionNo: number; tripVersion: number }>> {
  return run(
    async (ctx) =>
      savePlan(ctx, {
        tripId: input.tripId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        executor: input.executor,
        departureAt: await departureOf(ctx, input.tripId, input.departureLocal),
        route: input.route,
        toll: input.toll,
        otherKop: input.otherKop,
      }),
    [...PAGES, `/trips/${input.tripId}`],
  );
}

export async function assignAction(tripId: string, expectedVersion: number): Promise<ActionResult<{ version: number }>> {
  return run((ctx) => assignTrip(ctx, { tripId, expectedVersion }), [...PAGES, `/trips/${tripId}`]);
}

export async function addOfferAction(input: {
  tripId: string;
  carrierId: string;
  rateKop: number | null;
  vatIncluded: boolean;
  vehicleDescr: string | null;
  confirmedArriveLocal: string | null;
  downtimeTerms: string | null;
  expectedDowntimeKop: number;
  source: string | null;
}): Promise<ActionResult<{ offerId: string }>> {
  return run(
    async (ctx) =>
      addCarrierOffer(ctx, {
        tripId: input.tripId,
        carrierId: input.carrierId,
        rateKop: input.rateKop,
        vatIncluded: input.vatIncluded,
        vehicleDescr: input.vehicleDescr,
        confirmedArriveAt: input.confirmedArriveLocal ? await departureOf(ctx, input.tripId, input.confirmedArriveLocal) : null,
        downtimeTerms: input.downtimeTerms,
        expectedDowntimeKop: input.expectedDowntimeKop,
        source: input.source,
      }),
    [...PAGES, `/trips/${input.tripId}`],
  );
}

export async function setOfferStatusAction(tripId: string, offerId: string, status: OfferStatus): Promise<ActionResult> {
  return run((ctx) => setOfferStatus(ctx, { offerId, status }), [...PAGES, `/trips/${tripId}`]);
}
