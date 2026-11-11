import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import { assignTrip, calculateRoutes, savePlan } from "@/server/services/planning";
import { createDriver, createVehicle } from "@/server/services/refs";
import { addOrderToTrip, createTrip, getTrip, type TripView } from "@/server/services/trips";
import { makeLocation, makeOrderLine, makeOrg, type TestOrg } from "./factories";

export type AssignedTrip = {
  org: TestOrg;
  logist: Ctx;
  tripId: string;
  vehicleId: string;
  driverId: string;
  trip: TripView;
};

export const DEPART = new Date("2026-11-12T03:00:00Z");

/** A trip with two delivery stops, planned with an own vehicle and driver, and assigned. */
export async function makeAssignedTrip(db: Db, org?: TestOrg, opts: { departureAt?: Date } = {}): Promise<AssignedTrip> {
  const departureAt = opts.departureAt ?? DEPART;
  const o = org ?? (await makeOrg(db));
  const logist = await o.as("logist");
  const warehouse = await makeLocation(logist, "Склад", {
    kind: "warehouse",
    lat: 55.0302,
    lon: 82.9204,
    contact: "Кладовщик, +7 900 000-00-01",
    entryNotes: "Ворота 2",
  });
  const shopA = await makeLocation(logist, "Магазин А", { lat: 55.06, lon: 82.95, passRules: "Пропуск на КПП" });
  const shopB = await makeLocation(logist, "Магазин Б", { lat: 55.07, lon: 82.99 });
  const { id: vehicleId } = await createVehicle(logist, {
    plate: "А001АА154",
    fuelNormLPer100Km: 25,
    maxPermMassT: 12,
    massT: 9,
    axleLoadT: 6,
    heightM: 3.4,
    widthM: 2.5,
    lengthM: 8.2,
  });
  const { id: driverId } = await createDriver(logist, { name: "Пётр Петров" });

  const { tripId } = await createTrip(logist, { originLocationId: warehouse });
  const a = await makeOrderLine(logist, { locationId: shopA, number: `З-${Math.random().toString(36).slice(2, 7)}-A`, palletsMilli: 5_000 });
  const b = await makeOrderLine(logist, { locationId: shopB, number: `З-${Math.random().toString(36).slice(2, 7)}-B`, palletsMilli: 5_000 });
  const { version } = await addOrderToTrip(logist, {
    tripId,
    expectedVersion: 1,
    items: [a, b].map((x) => ({ orderLineId: x.lineId, qtyMilli: 5_000 })),
  });

  const calc = await calculateRoutes(logist, { tripId, departureAt, vehicleId, avoidToll: false });
  if (!calc.result.ok) throw new Error(calc.result.reason);
  const saved = await savePlan(logist, {
    tripId,
    expectedVersion: version,
    reason: null,
    executor: { kind: "own", vehicleId, driverId },
    departureAt,
    route: { kind: "sealed", token: calc.result.variants[0].token },
    toll: { kind: "none" },
    otherKop: 0,
  });
  await assignTrip(logist, { tripId, expectedVersion: saved.tripVersion });
  return { org: o, logist, tripId, vehicleId, driverId, trip: await getTrip(logist, tripId) };
}
