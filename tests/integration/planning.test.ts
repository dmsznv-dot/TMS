import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { recordRoutingRequest } from "@/server/routing/quota";
import { createSyntheticProvider } from "@/server/routing/synthetic";
import { sealVariant } from "@/server/routing/variantToken";
import type { RouteRequest, RoutingProvider } from "@/server/routing/types";
import {
  assignTrip,
  calculateRoutes,
  isPlanStale,
  listExecutorOptions,
  listPlanVersions,
  savePlan,
  type ClientVariant,
} from "@/server/services/planning";
import { addCarrierOffer, listOffers, setOfferStatus } from "@/server/services/offers";
import { createCounterparty, createDriver, createVehicle, setVehicleActive, updateLocation } from "@/server/services/refs";
import { addOrderToTrip, createTrip, getTrip } from "@/server/services/trips";
import { expectCode } from "../helpers/expectCode";
import { makeLocation, makeOrderLine, makeOrg } from "../helpers/factories";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;
const ORIGINAL = { ...process.env };

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

const DEPART = new Date("2026-11-12T03:00:00Z");
const FULL_PROFILE = { maxPermMassT: 12, massT: 9, axleLoadT: 6, heightM: 3.4, widthM: 2.5, lengthM: 8.2 };

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const org = await makeOrg(db);
  const logist = await org.as("logist");
  const warehouse = await makeLocation(logist, "Склад", { kind: "warehouse", lat: 55.0302, lon: 82.9204, serviceMin: 20 });
  const shopA = await makeLocation(logist, "Магазин А", { lat: 55.06, lon: 82.95 });
  const shopB = await makeLocation(logist, "Магазин Б", { lat: 55.07, lon: 82.99 });
  const { id: vehicleId } = await createVehicle(logist, { plate: "А001АА154", fuelNormLPer100Km: 25, ...FULL_PROFILE });
  const { id: driverId } = await createDriver(logist, { name: "Пётр Петров" });
  const { id: carrierId } = await createCounterparty(logist, { name: "ИП Перевозов", kind: "carrier" });
  return { org, logist, warehouse, shopA, shopB, vehicleId, driverId, carrierId };
}

/** A trip with cargo for both shops, ready to calculate. */
async function tripWithCargo(s: Setup, number = "З-1") {
  const { tripId } = await createTrip(s.logist, { originLocationId: s.warehouse });
  const a = await makeOrderLine(s.logist, { locationId: s.shopA, number: `${number}-A` });
  const b = await makeOrderLine(s.logist, { locationId: s.shopB, number: `${number}-B` });
  const { version } = await addOrderToTrip(s.logist, {
    tripId,
    expectedVersion: 1,
    items: [a, b].map((o) => ({ orderLineId: o.lineId, qtyMilli: 5_000 })),
  });
  return { tripId, version };
}

async function calculate(s: Setup, tripId: string, patch: Partial<Parameters<typeof calculateRoutes>[1]> = {}) {
  const calc = await calculateRoutes(s.logist, { tripId, departureAt: DEPART, vehicleId: s.vehicleId, avoidToll: false, ...patch });
  if (!calc.result.ok) throw new Error(`calculation failed: ${calc.result.reason}`);
  return calc.result.variants;
}

async function plan(s: Setup, tripId: string, version: number, patch: Partial<Parameters<typeof savePlan>[1]> = {}) {
  const [variant] = await calculate(s, tripId);
  return savePlan(s.logist, {
    tripId,
    expectedVersion: version,
    reason: null,
    executor: { kind: "own", vehicleId: s.vehicleId, driverId: s.driverId },
    departureAt: DEPART,
    route: { kind: "sealed", token: variant.token },
    toll: { kind: "none" },
    otherKop: 0,
    ...patch,
  });
}

const spyProvider = (calls: RouteRequest[]): RoutingProvider => ({
  async buildRoutes(req) {
    calls.push(req);
    return createSyntheticProvider().buildRoutes(req);
  },
});

describe("calculateRoutes", () => {
  it("calculates variants with stop plans in synthetic mode", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    const calc = await calculateRoutes(s.logist, { tripId, departureAt: DEPART, vehicleId: s.vehicleId, avoidToll: false });

    expect(calc.quota).toMatchObject({ live: false, used: 0 });
    if (!calc.result.ok) throw new Error(calc.result.reason);
    expect(calc.result.variants).toHaveLength(2);
    for (const v of calc.result.variants) {
      expect(v.source).toBe("synthetic");
      expect(v.token).toBeTruthy();
      expect(v.stops).toHaveLength(2);
      expect(v.legDurationsS).toHaveLength(2);
      expect(v.stops[0].arriveAt.getTime()).toBe(DEPART.getTime() + v.legDurationsS[0] * 1000);
      expect(v.stops[0].windowState).toBe("on_time");
      expect(v.profileComplete).toBe(true);
    }
  });

  it("drives to the entry point of a distribution center", async () => {
    const s = await setup();
    const dc = await makeLocation(s.logist, "РЦ", { kind: "dc", lat: 55.1, lon: 83.0, entryLat: 55.11, entryLon: 83.02 });
    const { tripId } = await createTrip(s.logist, { originLocationId: s.warehouse });
    const o = await makeOrderLine(s.logist, { locationId: dc, number: "З-РЦ" });
    await addOrderToTrip(s.logist, { tripId, expectedVersion: 1, items: [{ orderLineId: o.lineId, qtyMilli: 1_000 }] });

    const calls: RouteRequest[] = [];
    await calculateRoutes(s.logist, { tripId, departureAt: DEPART, vehicleId: null, avoidToll: false }, { provider: spyProvider(calls) });

    expect(calls[0].points[1]).toEqual({ lat: 55.11, lon: 83.02 });
    expect(calls[0].points[0]).toEqual({ lat: 55.0302, lon: 82.9204 });
  });

  it("passes the vehicle profile and the toll filter to the provider", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    const calls: RouteRequest[] = [];
    await calculateRoutes(s.logist, { tripId, departureAt: DEPART, vehicleId: s.vehicleId, avoidToll: true }, { provider: spyProvider(calls) });
    expect(calls[0].avoid).toEqual(["toll_road"]);
    expect(calls[0].truck).toMatchObject({ maxPermMassT: 12, heightM: 3.4 });
  });

  it("marks the variants as built without toll roads when asked", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    const variants = await calculate(s, tripId, { avoidToll: true });
    expect(variants.every((v) => v.tollFiltered)).toBe(true);
  });

  it("flags an incomplete vehicle profile", async () => {
    const s = await setup();
    const { id } = await createVehicle(s.logist, { plate: "Б002ББ154" });
    const { tripId } = await tripWithCargo(s);
    const variants = await calculate(s, tripId, { vehicleId: id });
    expect(variants.every((v) => v.profileComplete === false)).toBe(true);
  });

  it("logs the request without keeping the answer", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await calculate(s, tripId);
    const rows = await db.execute(sql`select provider, ok from routing_request_log where org_id = ${s.org.orgId}`);
    expect(rows.rows).toEqual([{ provider: "synthetic", ok: true }]);
  });

  it("refuses a trip with nothing to deliver", async () => {
    const s = await setup();
    const { tripId } = await createTrip(s.logist, { originLocationId: s.warehouse });
    const calc = await calculateRoutes(s.logist, { tripId, departureAt: DEPART, vehicleId: null, avoidToll: false });
    expect(calc.result).toMatchObject({ ok: false, reason: "bad_request" });
  });

  it("returns the provider failure and still reports the quota", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    const failing: RoutingProvider = { buildRoutes: async () => ({ ok: false, reason: "timeout", message: "2ГИС не ответил" }) };
    const calc = await calculateRoutes(s.logist, { tripId, departureAt: DEPART, vehicleId: null, avoidToll: false }, { provider: failing });
    expect(calc.result).toMatchObject({ ok: false, reason: "timeout" });
    expect(calc.quota.limit).toBe(1000);
  });

  it("does not call the provider once the live limit is reached", async () => {
    process.env.ROUTING_MODE = "live";
    process.env.TWOGIS_API_KEY = "k";
    process.env.TWOGIS_REQUEST_LIMIT = "1";
    resetEnvCache();
    const t = await withTestDb();
    try {
      const s = await setup2(t.db);
      const { tripId } = await tripWithCargo(s);
      await recordRoutingRequest(s.logist, { provider: "2gis", ok: true });
      const calls: RouteRequest[] = [];
      const calc = await calculateRoutes(s.logist, { tripId, departureAt: DEPART, vehicleId: null, avoidToll: false }, { provider: spyProvider(calls) });
      expect(calc.result).toMatchObject({ ok: false, reason: "quota" });
      expect(calls).toHaveLength(0);
      expect(calc.quota).toMatchObject({ used: 1, limit: 1, live: true });
    } finally {
      await t.close();
    }
  });

  it("asks for confirmation before sending a far leg to a demo key", async () => {
    process.env.ROUTING_MODE = "live";
    process.env.TWOGIS_API_KEY = "k";
    resetEnvCache();
    const s = await setup();
    const far = await makeLocation(s.logist, "Бердск", { lat: 54.76, lon: 83.1 }); // about 30 km: fine
    const farther = await makeLocation(s.logist, "Томск", { lat: 56.49, lon: 84.95 }); // hundreds of km
    const { tripId } = await createTrip(s.logist, { originLocationId: s.warehouse });
    const near = await makeOrderLine(s.logist, { locationId: far, number: "З-Б" });
    const distant = await makeOrderLine(s.logist, { locationId: farther, number: "З-Т" });
    await addOrderToTrip(s.logist, {
      tripId,
      expectedVersion: 1,
      items: [near, distant].map((o) => ({ orderLineId: o.lineId, qtyMilli: 1_000 })),
    });

    const calls: RouteRequest[] = [];
    const input = { tripId, departureAt: DEPART, vehicleId: null, avoidToll: false };
    const first = await calculateRoutes(s.logist, input, { provider: spyProvider(calls) });
    expect(first.needsConfirmation).toBe(true);
    expect(first.warnings[0]).toContain("50 км");
    expect(calls).toHaveLength(0);

    const second = await calculateRoutes(s.logist, { ...input, confirmFar: true }, { provider: spyProvider(calls) });
    expect(second.needsConfirmation).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("is not available to the warehouse role", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await expectCode(
      calculateRoutes(await s.org.as("warehouse"), { tripId, departureAt: DEPART, vehicleId: null, avoidToll: false }),
      "forbidden",
    );
  });
});

/** Same as setup() but on another database, for tests that need an empty request log. */
async function setup2(otherDb: Db): Promise<Setup> {
  const org = await makeOrg(otherDb);
  const logist = await org.as("logist");
  const warehouse = await makeLocation(logist, "Склад", { kind: "warehouse", lat: 55.0302, lon: 82.9204 });
  const shopA = await makeLocation(logist, "Магазин А", { lat: 55.06, lon: 82.95 });
  const shopB = await makeLocation(logist, "Магазин Б", { lat: 55.07, lon: 82.99 });
  const { id: vehicleId } = await createVehicle(logist, { plate: "А001АА154", ...FULL_PROFILE });
  const { id: driverId } = await createDriver(logist, { name: "Пётр" });
  const { id: carrierId } = await createCounterparty(logist, { name: "ИП", kind: "carrier" });
  return { org, logist, warehouse, shopA, shopB, vehicleId, driverId, carrierId };
}

describe("executor options", () => {
  async function options(s: Setup, ctx: Ctx, tripId: string, variants: ClientVariant[], departureAt = DEPART) {
    return listExecutorOptions(ctx, { tripId, departureAt, variants: variants.map((v) => ({ token: v.token })) });
  }

  it("lists own vehicles and quoted offers as options", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await addCarrierOffer(s.logist, { tripId, carrierId: s.carrierId, rateKop: 41_000_00, vatIncluded: false, status: "quoted" });
    const rejected = await addCarrierOffer(s.logist, { tripId, carrierId: s.carrierId, rateKop: 10_000_00, vatIncluded: false, status: "quoted" });
    await setOfferStatus(s.logist, { offerId: rejected.offerId, status: "rejected" });
    const candidate = await addCarrierOffer(s.logist, { tripId, carrierId: s.carrierId, status: "candidate" });

    const variants = await calculate(s, tripId);
    const { rows } = await options(s, s.logist, tripId, variants);

    expect(rows.filter((r) => r.executor === "own")).toHaveLength(2); // one vehicle × two variants
    expect(rows.filter((r) => r.executor === "carrier")).toHaveLength(2); // one usable offer × two variants
    expect(rows.some((r) => r.offerId === rejected.offerId || r.offerId === candidate.offerId)).toBe(false);
  });

  it("puts options that make every window first, cheapest first", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await addCarrierOffer(s.logist, { tripId, carrierId: s.carrierId, rateKop: 41_000_00, vatIncluded: false });
    const variants = await calculate(s, tripId);
    const { rows } = await options(s, s.logist, tripId, variants);

    expect(rows.every((r) => r.fits)).toBe(true);
    const totals = rows.map((r) => r.cost.totalKop);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
  });

  it("builds the cost of an own vehicle from norms and the carrier rate on the net base", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await addCarrierOffer(s.logist, { tripId, carrierId: s.carrierId, rateKop: 50_020_00, vatIncluded: true });
    const variants = await calculate(s, tripId, { avoidToll: true });
    const { rows } = await options(s, s.logist, tripId, variants);

    const own = rows.find((r) => r.executor === "own")!;
    expect(own.cost.lines.map((l) => l.category)).toEqual(["fuel", "driver", "tolls"]);
    expect(own.cost.lines.find((l) => l.category === "tolls")!.kop).toBe(0); // built without toll roads
    expect(own.cost.incomplete).toBe(false);
    expect(rows.find((r) => r.executor === "carrier")!.cost.totalKop).toBe(41_000_00);
  });

  it("keeps tolls unknown for a variant that may use toll roads", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    const variants = await calculate(s, tripId);
    const { rows } = await options(s, s.logist, tripId, variants);
    expect(rows.find((r) => r.executor === "own")!.cost.incomplete).toBe(true);
  });

  it("uses the time a carrier confirmed instead of the planned departure", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await addCarrierOffer(s.logist, {
      tripId,
      carrierId: s.carrierId,
      rateKop: 41_000_00,
      vatIncluded: false,
      confirmedArriveAt: new Date("2026-11-12T06:30:00Z"),
    });
    const variants = await calculate(s, tripId);
    const { rows } = await options(s, s.logist, tripId, variants);
    const carrier = rows.find((r) => r.executor === "carrier")!;
    expect(carrier.stops[0].arriveAt.toISOString()).toBe("2026-11-12T06:30:00.000Z");
    expect(carrier.label).not.toContain("не подтверждено");
  });

  it("marks a carrier option whose time is not confirmed", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await addCarrierOffer(s.logist, { tripId, carrierId: s.carrierId, rateKop: 41_000_00, vatIncluded: false });
    const { rows } = await options(s, s.logist, tripId, await calculate(s, tripId));
    expect(rows.find((r) => r.executor === "carrier")!.label).toContain("время не подтверждено");
  });

  it("excludes a vehicle that is busy on an overlapping trip", async () => {
    const s = await setup();
    const first = await tripWithCargo(s, "З-1");
    await plan(s, first.tripId, first.version);

    const second = await tripWithCargo(s, "З-2");
    const variants = await calculate(s, second.tripId);

    const overlapping = await options(s, s.logist, second.tripId, variants, new Date("2026-11-12T03:30:00Z"));
    expect(overlapping.rows.some((r) => r.vehicleId === s.vehicleId)).toBe(false);
    expect(overlapping.excluded).toEqual([expect.objectContaining({ vehicleId: s.vehicleId, reason: "busy" })]);

    const later = await options(s, s.logist, second.tripId, variants, new Date("2026-11-12T12:00:00Z"));
    expect(later.rows.some((r) => r.vehicleId === s.vehicleId)).toBe(true);
    expect(later.excluded).toEqual([]);
  });

  it("does not count the trip's own saved plan as a conflict", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await plan(s, t.tripId, t.version);
    const { rows } = await options(s, s.logist, t.tripId, await calculate(s, t.tripId));
    expect(rows.some((r) => r.vehicleId === s.vehicleId)).toBe(true);
  });

  it("excludes an inactive vehicle", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await setVehicleActive(s.logist, s.vehicleId, false);
    const { rows, excluded } = await options(s, s.logist, tripId, await calculate(s, tripId, { vehicleId: null }));
    expect(rows.some((r) => r.vehicleId === s.vehicleId)).toBe(false);
    expect(excluded).toEqual([]);
  });

  it("excludes a vehicle that is too small for the cargo", async () => {
    const s = await setup();
    const { id: small } = await createVehicle(s.logist, { plate: "М003ММ154", capacityPallets: 1, ...FULL_PROFILE });
    const { tripId } = await createTrip(s.logist, { originLocationId: s.warehouse });
    const o = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-П", palletsMilli: 10_000 });
    await addOrderToTrip(s.logist, { tripId, expectedVersion: 1, items: [{ orderLineId: o.lineId, qtyMilli: 10_000 }] });

    const { rows, excluded } = await options(s, s.logist, tripId, await calculate(s, tripId, { vehicleId: null }));
    expect(rows.some((r) => r.vehicleId === small)).toBe(false);
    expect(excluded).toEqual([expect.objectContaining({ vehicleId: small, reason: "capacity" })]);
    expect(rows.some((r) => r.vehicleId === s.vehicleId)).toBe(true);
  });

  it("rejects a forged or expired variant", async () => {
    const s = await setup();
    const { tripId } = await tripWithCargo(s);
    await expectCode(
      listExecutorOptions(s.logist, { tripId, departureAt: DEPART, variants: [{ token: "forged.token" }] }),
      "variant_expired",
    );
  });

  it("rejects a variant calculated for a different set of stops", async () => {
    const s = await setup();
    const { tripId, version } = await tripWithCargo(s);
    const variants = await calculate(s, tripId);
    const c = await makeOrderLine(s.logist, { locationId: await makeLocation(s.logist, "Магазин В"), number: "З-В" });
    await addOrderToTrip(s.logist, { tripId, expectedVersion: version, items: [{ orderLineId: c.lineId, qtyMilli: 1_000 }] });
    await expectCode(options(s, s.logist, tripId, variants), "variant_stale");
  });
});

describe("savePlan", () => {
  it("saves plan version 1 and moves the trip to planned", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const saved = await plan(s, t.tripId, t.version);

    expect(saved).toMatchObject({ versionNo: 1 });
    const trip = await getTrip(s.logist, t.tripId);
    expect(trip.status).toBe("planned");
    expect(trip.version).toBe(saved.tripVersion);

    const [v1] = await listPlanVersions(s.logist, t.tripId);
    expect(v1).toMatchObject({
      versionNo: 1,
      isCurrent: true,
      executor: "own",
      metricsSource: "synthetic",
      vehicle: { id: s.vehicleId, plate: "А001АА154" },
      driver: { id: s.driverId, name: "Пётр Петров" },
    });
    expect(v1.stops).toHaveLength(3);
    expect(v1.stops[0]).toMatchObject({ operation: "load", locationName: "Склад" });
    expect(v1.stops[1]).toMatchObject({ locationName: "Магазин А", windowState: "on_time" });
    expect(v1.totalKop).toBeGreaterThan(0);
  });

  it("requires a reason from version 2 and keeps version 1 unchanged", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const first = await plan(s, t.tripId, t.version);
    const [before] = await listPlanVersions(s.logist, t.tripId);

    await expectCode(plan(s, t.tripId, first.tripVersion), "reason_required");
    await expectCode(plan(s, t.tripId, first.tripVersion, { reason: "   " }), "reason_required");
    const second = await plan(s, t.tripId, first.tripVersion, { reason: "Сдвиг окна", departureAt: new Date("2026-11-12T03:30:00Z") });

    const versions = await listPlanVersions(s.logist, t.tripId);
    expect(second.versionNo).toBe(2);
    expect(versions.map((v) => [v.versionNo, v.isCurrent])).toEqual([[2, true], [1, false]]);
    expect(versions[0].reason).toBe("Сдвиг окна");
    expect(versions[1]).toEqual({ ...before, isCurrent: false });
  });

  it("keeps the saved snapshot after location coordinates change", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await plan(s, t.tripId, t.version);
    await updateLocation(s.logist, s.shopA, { lat: 55.5, name: "Магазин А (новый)" });

    const [v1] = await listPlanVersions(s.logist, t.tripId);
    expect(v1.stops[1]).toMatchObject({ locationName: "Магазин А", lat: 55.06 });
  });

  it("keeps the saved plan after its vehicle is deactivated", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await plan(s, t.tripId, t.version);
    await setVehicleActive(s.logist, s.vehicleId, false);

    const [v1] = await listPlanVersions(s.logist, t.tripId);
    expect(v1.vehicle).toMatchObject({ id: s.vehicleId, plate: "А001АА154" });
  });

  it("refuses an inactive vehicle or driver in a new plan", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await setVehicleActive(s.logist, s.vehicleId, false);
    await expectCode(plan(s, t.tripId, t.version), "vehicle_inactive");
  });

  it("stores manual metrics with source manual", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await plan(s, t.tripId, t.version, { route: { kind: "manual", distanceM: 12_000, durationS: 1_800 } });
    const [v1] = await listPlanVersions(s.logist, t.tripId);
    expect(v1).toMatchObject({ metricsSource: "manual", distanceM: 12_000, durationS: 1_800, legsEstimated: true });
    expect(v1.stops[1].legDurationS! + v1.stops[2].legDurationS!).toBe(1_800);
  });

  it("rejects manual metrics that are not positive", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await expectCode(plan(s, t.tripId, t.version, { route: { kind: "manual", distanceM: 0, durationS: 60 } }), "validation");
  });

  it("refuses to store 2GIS metrics when storage is switched off", async () => {
    process.env.ROUTE_METRICS_STORAGE = "none";
    resetEnvCache();
    const s = await setup();
    const t = await tripWithCargo(s);
    const token = sealVariant({
      source: "2gis",
      distanceM: 9_000,
      durationS: 1_200,
      legDurationsS: [600, 600],
      legsEstimated: true,
      tollFiltered: false,
      profileComplete: true,
    });
    await expectCode(plan(s, t.tripId, t.version, { route: { kind: "sealed", token } }), "provider_metrics_not_storable");

    // The built-in demo calculation and manual values are still fine.
    await plan(s, t.tripId, t.version, { route: { kind: "manual", distanceM: 9_000, durationS: 1_200 } });
  });

  it("stores 2GIS metrics with their source when storage is on", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const token = sealVariant({
      source: "2gis",
      distanceM: 9_000,
      durationS: 1_200,
      legDurationsS: [600, 600],
      legsEstimated: true,
      tollFiltered: false,
      profileComplete: false,
    });
    await plan(s, t.tripId, t.version, { route: { kind: "sealed", token } });
    const [v1] = await listPlanVersions(s.logist, t.tripId);
    expect(v1).toMatchObject({ metricsSource: "2gis", distanceM: 9_000, profileComplete: false, legsEstimated: true });
  });

  it("rejects a forged token and a token for another set of stops", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await expectCode(plan(s, t.tripId, t.version, { route: { kind: "sealed", token: "x.y" } }), "variant_expired");
    const token = sealVariant({
      source: "synthetic",
      distanceM: 1,
      durationS: 1,
      legDurationsS: [1],
      legsEstimated: false,
      tollFiltered: false,
      profileComplete: true,
    });
    await expectCode(plan(s, t.tripId, t.version, { route: { kind: "sealed", token } }), "variant_stale");
  });

  it("rejects a stale trip version", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await expectCode(plan(s, t.tripId, t.version - 1), "stale");
  });

  it("computes the cost of a carrier plan on the net base", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const { offerId } = await addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: s.carrierId, rateKop: 50_020_00, vatIncluded: true });
    await plan(s, t.tripId, t.version, { executor: { kind: "carrier", offerId } });
    const [v1] = await listPlanVersions(s.logist, t.tripId);
    expect(v1).toMatchObject({ executor: "carrier", totalKop: 41_000_00, offer: { id: offerId, carrierName: "ИП Перевозов" } });
    expect(v1.vehicle).toBeNull();
  });

  it("refuses an offer that is not usable or belongs to another trip", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const other = await tripWithCargo(s, "З-2");
    const mine = await addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: s.carrierId, status: "candidate" });
    const foreign = await addCarrierOffer(s.logist, { tripId: other.tripId, carrierId: s.carrierId, rateKop: 1_000_00, vatIncluded: false });
    await expectCode(plan(s, t.tripId, t.version, { executor: { kind: "carrier", offerId: mine.offerId } }), "offer_not_usable");
    await expectCode(plan(s, t.tripId, t.version, { executor: { kind: "carrier", offerId: foreign.offerId } }), "not_found");
  });

  it("flags a plan whose stops no longer match the trip", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const saved = await plan(s, t.tripId, t.version);
    const [current] = await listPlanVersions(s.logist, t.tripId);
    expect(isPlanStale(current, await getTrip(s.logist, t.tripId))).toBe(false);

    const extra = await makeOrderLine(s.logist, { locationId: await makeLocation(s.logist, "Магазин Г"), number: "З-Г" });
    await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: saved.tripVersion, items: [{ orderLineId: extra.lineId, qtyMilli: 1_000 }] });
    expect(isPlanStale(current, await getTrip(s.logist, t.tripId))).toBe(true);
  });

  it("is hidden from roles without access to money", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await plan(s, t.tripId, t.version);
    await expectCode(listPlanVersions(await s.org.as("warehouse"), t.tripId), "forbidden");
    expect(await listPlanVersions(await s.org.as("finance"), t.tripId)).toHaveLength(1);
  });

  it("is isolated between organizations", async () => {
    const s = await setup();
    const other = await setup();
    const t = await tripWithCargo(s);
    await plan(s, t.tripId, t.version);
    await expectCode(listPlanVersions(other.logist, t.tripId), "not_found");
  });
});

describe("assignment", () => {
  it("assigns a trip planned with an own vehicle and driver", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const saved = await plan(s, t.tripId, t.version);
    await assignTrip(s.logist, { tripId: t.tripId, expectedVersion: saved.tripVersion });
    expect((await getTrip(s.logist, t.tripId)).status).toBe("assigned");
  });

  it("does not assign a trip that has no plan yet", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await expectCode(assignTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version }), "invalid_transition");
  });

  it("requires a confirmed offer for a carrier", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const { offerId } = await addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: s.carrierId, rateKop: 41_000_00, vatIncluded: false });
    const saved = await plan(s, t.tripId, t.version, { executor: { kind: "carrier", offerId } });

    await expectCode(assignTrip(s.logist, { tripId: t.tripId, expectedVersion: saved.tripVersion }), "executor_not_ready");
    await setOfferStatus(s.logist, { offerId, status: "confirmed" });
    const trip = await getTrip(s.logist, t.tripId);
    await assignTrip(s.logist, { tripId: t.tripId, expectedVersion: trip.version });
    expect((await getTrip(s.logist, t.tripId)).status).toBe("assigned");
  });

  it("sets the baseline plan on the first assignment only", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const first = await plan(s, t.tripId, t.version);
    await assignTrip(s.logist, { tripId: t.tripId, expectedVersion: first.tripVersion });
    const afterFirst = await getTrip(s.logist, t.tripId);
    const [v1] = await listPlanVersions(s.logist, t.tripId);
    expect(afterFirst.baselinePlanVersionId).toBe(v1.id);

    // A new driver means a new executor: the trip goes back to planned, then is assigned again.
    const { id: driver2 } = await createDriver(s.logist, { name: "Иван Иванов" });
    const second = await plan(s, t.tripId, afterFirst.version, { reason: "Заболел водитель", executor: { kind: "own", vehicleId: s.vehicleId, driverId: driver2 } });
    expect((await getTrip(s.logist, t.tripId)).status).toBe("planned");
    await assignTrip(s.logist, { tripId: t.tripId, expectedVersion: second.tripVersion });

    const final = await getTrip(s.logist, t.tripId);
    expect(final.status).toBe("assigned");
    expect(final.baselinePlanVersionId).toBe(v1.id);
  });

  it("returns an assigned trip to planned when the executor changes, not when only the time does", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const first = await plan(s, t.tripId, t.version);
    await assignTrip(s.logist, { tripId: t.tripId, expectedVersion: first.tripVersion });
    const assigned = await getTrip(s.logist, t.tripId);

    const retimed = await plan(s, t.tripId, assigned.version, { reason: "Сдвиг выезда", departureAt: new Date("2026-11-12T03:20:00Z") });
    expect((await getTrip(s.logist, t.tripId)).status).toBe("assigned");

    const { id: vehicle2 } = await createVehicle(s.logist, { plate: "Н004НН154", ...FULL_PROFILE });
    await plan(s, t.tripId, retimed.tripVersion, { reason: "Поломка", executor: { kind: "own", vehicleId: vehicle2, driverId: s.driverId } });
    expect((await getTrip(s.logist, t.tripId)).status).toBe("planned");
  });

  it("locks stops once the trip is assigned but still allows re-planning", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const first = await plan(s, t.tripId, t.version);
    await assignTrip(s.logist, { tripId: t.tripId, expectedVersion: first.tripVersion });
    const o = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-X" });
    const version = (await getTrip(s.logist, t.tripId)).version;
    await expectCode(
      addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: version, items: [{ orderLineId: o.lineId, qtyMilli: 1_000 }] }),
      "trip_locked",
    );
    await plan(s, t.tripId, version, { reason: "Новое время", departureAt: new Date("2026-11-12T03:10:00Z") });
  });
});

describe("carrier offers", () => {
  it("records an offer with a rate that has VAT and lists it with the carrier name", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    const { offerId } = await addCarrierOffer(s.logist, {
      tripId: t.tripId,
      carrierId: s.carrierId,
      rateKop: 41_000_00,
      vatIncluded: true,
      vehicleDescr: "Газель, тент",
      downtimeTerms: "Первые 2 часа бесплатно",
      expectedDowntimeKop: 0,
      source: "звонок",
    });
    const offers = await listOffers(s.logist, t.tripId);
    expect(offers).toEqual([
      expect.objectContaining({ id: offerId, carrierName: "ИП Перевозов", rateKop: 41_000_00, vatIncluded: true, vatRateBp: 2200, status: "quoted", source: "звонок" }),
    ]);
  });

  it("needs a rate before an offer is quoted or confirmed", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await expectCode(addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: s.carrierId, status: "quoted" }), "rate_required");
    const { offerId } = await addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: s.carrierId, status: "candidate" });
    await expectCode(setOfferStatus(s.logist, { offerId, status: "confirmed" }), "rate_required");
  });

  it("accepts only a carrier from the same organization", async () => {
    const s = await setup();
    const other = await setup();
    const t = await tripWithCargo(s);
    const customer = await createCounterparty(s.logist, { name: "ООО Ромашка", kind: "customer" });
    await expectCode(addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: customer.id, rateKop: 1_00, vatIncluded: false }), "validation");
    await expectCode(addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: other.carrierId, rateKop: 1_00, vatIncluded: false }), "not_found");
  });

  it("is limited to roles that handle money and planning", async () => {
    const s = await setup();
    const t = await tripWithCargo(s);
    await expectCode(addCarrierOffer(await s.org.as("warehouse"), { tripId: t.tripId, carrierId: s.carrierId, rateKop: 1_00, vatIncluded: false }), "forbidden");
    await expectCode(listOffers(await s.org.as("warehouse"), t.tripId), "forbidden");
    expect(await listOffers(await s.org.as("manager"), t.tripId)).toEqual([]);
  });

  it("cannot be changed in another organization", async () => {
    const s = await setup();
    const other = await setup();
    const t = await tripWithCargo(s);
    const { offerId } = await addCarrierOffer(s.logist, { tripId: t.tripId, carrierId: s.carrierId, rateKop: 1_00, vatIncluded: false });
    await expectCode(setOfferStatus(other.logist, { offerId, status: "rejected" }), "not_found");
  });
});
