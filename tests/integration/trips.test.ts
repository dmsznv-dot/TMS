import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { getOrder, listOrders, upsertOrder } from "@/server/services/orders";
import {
  addOrderToTrip,
  createTrip,
  getTrip,
  listTrips,
  removeCargo,
  reorderStops,
  transitionTrip,
} from "@/server/services/trips";
import { expectCode } from "../helpers/expectCode";
import { makeLocation, makeOrderLine, makeOrg } from "../helpers/factories";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

async function setup() {
  const org = await makeOrg(db);
  const logist = await org.as("logist");
  const warehouse = await makeLocation(logist, "Склад", { kind: "warehouse", serviceMin: 20 });
  const shopA = await makeLocation(logist, "Магазин А");
  const shopB = await makeLocation(logist, "Магазин Б");
  return { org, logist, warehouse, shopA, shopB };
}

async function newTrip(s: Awaited<ReturnType<typeof setup>>) {
  const { tripId } = await createTrip(s.logist, { originLocationId: s.warehouse });
  return { tripId, version: (await getTrip(s.logist, tripId)).version };
}

describe("createTrip", () => {
  it("starts as a draft with a numbered loading stop", async () => {
    const s = await setup();
    const { tripId, number } = await createTrip(s.logist, { originLocationId: s.warehouse });
    const trip = await getTrip(s.logist, tripId);

    expect(number).toMatch(/^Р-\d{4}$/);
    expect(trip).toMatchObject({ number, status: "draft", version: 1 });
    expect(trip.stops).toHaveLength(1);
    expect(trip.stops[0]).toMatchObject({ seq: 1, operation: "load", location: { name: "Склад" } });
  });

  it("numbers trips one after another within the organization", async () => {
    const s = await setup();
    const a = await createTrip(s.logist, { originLocationId: s.warehouse });
    const b = await createTrip(s.logist, { originLocationId: s.warehouse });
    expect(a.number).toBe("Р-0001");
    expect(b.number).toBe("Р-0002");
  });

  it("rejects a point of another organization", async () => {
    const s = await setup();
    const other = await setup();
    await expectCode(createTrip(s.logist, { originLocationId: other.warehouse }), "location_not_found");
  });
});

describe("allocation", () => {
  it("splits one order line across two trips", async () => {
    const s = await setup();
    const { orderId, lineId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const a = await newTrip(s);
    const b = await newTrip(s);

    await addOrderToTrip(s.logist, { tripId: a.tripId, expectedVersion: a.version, items: [{ orderLineId: lineId, qtyMilli: 6_000 }] });
    await addOrderToTrip(s.logist, { tripId: b.tripId, expectedVersion: b.version, items: [{ orderLineId: lineId, qtyMilli: 4_000 }] });

    const order = await getOrder(s.logist, orderId);
    expect(order.lines[0]).toMatchObject({ allocatedOpenMilli: 10_000, remainingMilli: 0 });
    expect(order.status).toBe("planned");
  });

  it("puts several orders into one trip with a stop per point", async () => {
    const s = await setup();
    const o1 = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const o2 = await makeOrderLine(s.logist, { locationId: s.shopB, number: "З-2" });
    const o3 = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-3" });
    const t = await newTrip(s);

    await addOrderToTrip(s.logist, {
      tripId: t.tripId,
      expectedVersion: t.version,
      items: [o1, o2, o3].map((o) => ({ orderLineId: o.lineId, qtyMilli: 5_000 })),
    });

    const trip = await getTrip(s.logist, t.tripId);
    expect(trip.stops.map((x) => [x.seq, x.operation, x.location.name])).toEqual([
      [1, "load", "Склад"],
      [2, "unload", "Магазин А"],
      [3, "unload", "Магазин Б"],
    ]);
    expect(trip.stops[1].cargo.map((c) => c.orderNumber)).toEqual(["З-1", "З-3"]);
  });

  it("adds to an existing cargo row when the same line is added again", async () => {
    const s = await setup();
    const { lineId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    const first = await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 3_000 }] });
    await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: first.version, items: [{ orderLineId: lineId, qtyMilli: 2_000 }] });

    const cargo = (await getTrip(s.logist, t.tripId)).stops[1].cargo;
    expect(cargo).toHaveLength(1);
    expect(cargo[0].qtyMilli).toBe(5_000);
  });

  it("derives the window of a stop from its orders", async () => {
    const s = await setup();
    const early = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1", windowStart: new Date("2026-11-12T01:00:00Z"), windowEnd: new Date("2026-11-12T08:00:00Z") });
    const late = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-2", windowStart: new Date("2026-11-12T03:00:00Z"), windowEnd: new Date("2026-11-12T06:00:00Z") });
    const t = await newTrip(s);
    await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [early, late].map((o) => ({ orderLineId: o.lineId, qtyMilli: 1_000 })) });

    const stop = (await getTrip(s.logist, t.tripId)).stops[1];
    expect(stop.windowStart?.toISOString()).toBe("2026-11-12T03:00:00.000Z");
    expect(stop.windowEnd?.toISOString()).toBe("2026-11-12T06:00:00.000Z");
  });

  it("rejects allocation above the remainder", async () => {
    const s = await setup();
    const { lineId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    await expectCode(
      addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 10_001 }] }),
      "exceeds_remaining",
    );
    await expectCode(
      addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 0 }] }),
      "validation",
    );
  });

  it("is all or nothing when one of several items is too large", async () => {
    const s = await setup();
    const a = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const b = await makeOrderLine(s.logist, { locationId: s.shopB, number: "З-2", qtyMilli: 1_000 });
    const t = await newTrip(s);
    await expectCode(
      addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: a.lineId, qtyMilli: 5_000 }, { orderLineId: b.lineId, qtyMilli: 2_000 }] }),
      "exceeds_remaining",
    );
    const trip = await getTrip(s.logist, t.tripId);
    expect(trip.stops).toHaveLength(1);
    expect(trip.version).toBe(t.version);
  });

  it("prevents concurrent over-allocation of one line", async () => {
    const s = await setup();
    const { lineId, orderId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const a = await newTrip(s);
    const b = await newTrip(s);

    const results = await Promise.allSettled([
      addOrderToTrip(s.logist, { tripId: a.tripId, expectedVersion: a.version, items: [{ orderLineId: lineId, qtyMilli: 6_000 }] }),
      addOrderToTrip(s.logist, { tripId: b.tripId, expectedVersion: b.version, items: [{ orderLineId: lineId, qtyMilli: 6_000 }] }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "exceeds_remaining" });
    expect((await getOrder(s.logist, orderId)).lines[0].remainingMilli).toBe(4_000);
  });

  it("refuses lines of a cancelled order and of another organization", async () => {
    const s = await setup();
    const other = await setup();
    const foreign = await makeOrderLine(other.logist, { locationId: other.shopA, number: "З-X" });
    const t = await newTrip(s);
    await expectCode(
      addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: foreign.lineId, qtyMilli: 1_000 }] }),
      "not_found",
    );
  });

  it("limits a trip to 10 stops", async () => {
    const s = await setup();
    const t = await newTrip(s);
    let version = t.version;
    for (let i = 1; i <= 9; i++) {
      const loc = await makeLocation(s.logist, `Точка ${i}`);
      const { lineId } = await makeOrderLine(s.logist, { locationId: loc, number: `З-${i}` });
      ({ version } = await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: version, items: [{ orderLineId: lineId, qtyMilli: 1_000 }] }));
    }
    expect((await getTrip(s.logist, t.tripId)).stops).toHaveLength(10);

    const loc = await makeLocation(s.logist, "Точка 10");
    const { lineId } = await makeOrderLine(s.logist, { locationId: loc, number: "З-10" });
    await expectCode(
      addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: version, items: [{ orderLineId: lineId, qtyMilli: 1_000 }] }),
      "too_many_stops",
    );
  });
});

describe("versions and permissions", () => {
  it("rejects a stale version", async () => {
    const s = await setup();
    const { lineId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 1_000 }] });
    await expectCode(
      addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 1_000 }] }),
      "stale",
    );
  });

  it("only planning roles change a trip", async () => {
    const s = await setup();
    const { lineId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    const wh = await s.org.as("warehouse");
    await expectCode(createTrip(wh, { originLocationId: s.warehouse }), "forbidden");
    await expectCode(addOrderToTrip(wh, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 1 }] }), "forbidden");
    expect((await getTrip(wh, t.tripId)).id).toBe(t.tripId);
  });

  it("hides other organizations' trips", async () => {
    const s = await setup();
    const other = await setup();
    const t = await newTrip(s);
    await expectCode(getTrip(other.logist, t.tripId), "not_found");
    expect(await listTrips(other.logist)).toEqual([]);
    expect((await listTrips(s.logist)).map((x) => x.id)).toEqual([t.tripId]);
  });
});

describe("editing cargo and stops", () => {
  it("removes cargo and drops a stop that has nothing left to unload", async () => {
    const s = await setup();
    const a = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const b = await makeOrderLine(s.logist, { locationId: s.shopB, number: "З-2" });
    const t = await newTrip(s);
    const added = await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [a, b].map((o) => ({ orderLineId: o.lineId, qtyMilli: 2_000 })) });

    const before = await getTrip(s.logist, t.tripId);
    await removeCargo(s.logist, { tripId: t.tripId, expectedVersion: added.version, tripCargoId: before.stops[1].cargo[0].id });

    const after = await getTrip(s.logist, t.tripId);
    expect(after.stops.map((x) => [x.seq, x.location.name])).toEqual([[1, "Склад"], [2, "Магазин Б"]]);
    expect((await getOrder(s.logist, a.orderId)).lines[0].remainingMilli).toBe(10_000);
  });

  it("reorders stops but keeps loading first", async () => {
    const s = await setup();
    const a = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const b = await makeOrderLine(s.logist, { locationId: s.shopB, number: "З-2" });
    const t = await newTrip(s);
    const added = await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [a, b].map((o) => ({ orderLineId: o.lineId, qtyMilli: 2_000 })) });
    const [load, stopA, stopB] = (await getTrip(s.logist, t.tripId)).stops.map((x) => x.id);

    await expectCode(reorderStops(s.logist, { tripId: t.tripId, expectedVersion: added.version, stopIds: [stopB, load, stopA] }), "validation");
    await expectCode(reorderStops(s.logist, { tripId: t.tripId, expectedVersion: added.version, stopIds: [load, stopB] }), "validation");

    await reorderStops(s.logist, { tripId: t.tripId, expectedVersion: added.version, stopIds: [load, stopB, stopA] });
    expect((await getTrip(s.logist, t.tripId)).stops.map((x) => x.location.name)).toEqual(["Склад", "Магазин Б", "Магазин А"]);
  });
});

describe("cancelling", () => {
  it("needs a reason and frees the allocation", async () => {
    const s = await setup();
    const { lineId, orderId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    const added = await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 10_000 }] });
    expect((await getOrder(s.logist, orderId)).lines[0].remainingMilli).toBe(0);

    await expectCode(transitionTrip(s.logist, { tripId: t.tripId, expectedVersion: added.version, to: "cancelled" }), "cancel_reason_required");
    await transitionTrip(s.logist, { tripId: t.tripId, expectedVersion: added.version, to: "cancelled", cancelReason: "Клиент отказался" });

    expect((await getTrip(s.logist, t.tripId))).toMatchObject({ status: "cancelled", cancelReason: "Клиент отказался" });
    expect((await getOrder(s.logist, orderId)).lines[0].remainingMilli).toBe(10_000);
  });

  it("a cancelled trip cannot be edited", async () => {
    const s = await setup();
    const { lineId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    const done = await transitionTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, to: "cancelled", cancelReason: "Ошибка" });
    await expectCode(addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: done.version, items: [{ orderLineId: lineId, qtyMilli: 1_000 }] }), "trip_locked");
  });

  it("refuses to move a draft to planned without a plan", async () => {
    const s = await setup();
    const t = await newTrip(s);
    await expectCode(transitionTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, to: "planned" }), "no_cargo");
  });
});

describe("listTrips", () => {
  it("filters by status", async () => {
    const s = await setup();
    const a = await newTrip(s);
    await newTrip(s);
    await transitionTrip(s.logist, { tripId: a.tripId, expectedVersion: a.version, to: "cancelled", cancelReason: "Тест" });
    expect((await listTrips(s.logist, { status: "cancelled" })).map((x) => x.id)).toEqual([a.tripId]);
    expect(await listTrips(s.logist, { status: "draft" })).toHaveLength(1);
  });
});

describe("orders and allocation", () => {
  it("upsertOrder rejects a quantity below what is allocated", async () => {
    const s = await setup();
    const { lineId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 6_000 }] });

    await expectCode(
      upsertOrder(s.logist, {
        source: "manual",
        number: "З-1",
        locationId: s.shopA,
        windowStart: new Date("2026-11-12T02:00:00Z"),
        windowEnd: new Date("2026-11-12T07:00:00Z"),
        lines: [{ lineKey: "1", qtyMilli: 5_000 }],
      }),
      "plan_conflict",
    );
    // Reducing down to exactly the allocated quantity is fine.
    await upsertOrder(s.logist, {
      source: "manual",
      number: "З-1",
      locationId: s.shopA,
      windowStart: new Date("2026-11-12T02:00:00Z"),
      windowEnd: new Date("2026-11-12T07:00:00Z"),
      lines: [{ lineKey: "1", qtyMilli: 6_000 }],
    });
    expect((await listOrders(s.logist))[0].lines[0].remainingMilli).toBe(0);
  });

  it("cannot cancel an order that stands on a trip", async () => {
    const s = await setup();
    const { lineId, orderId } = await makeOrderLine(s.logist, { locationId: s.shopA, number: "З-1" });
    const t = await newTrip(s);
    await addOrderToTrip(s.logist, { tripId: t.tripId, expectedVersion: t.version, items: [{ orderLineId: lineId, qtyMilli: 1_000 }] });
    const { cancelOrder } = await import("@/server/services/orders");
    await expectCode(cancelOrder(s.logist, orderId), "plan_conflict");
  });
});
