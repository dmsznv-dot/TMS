import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { shareLinks } from "@/server/db/schema";
import {
  confirmLoading,
  getDriverView,
  listTripEvents,
  recordEvent,
  setMileage,
  setStopFact,
} from "@/server/services/execution";
import { createShareLink, ctxFromShareToken, listShareLinks, revokeShareLink } from "@/server/services/shareLinks";
import { getTrip, transitionTrip } from "@/server/services/trips";
import { expectCode } from "../helpers/expectCode";
import { makeOrg } from "../helpers/factories";
import { makeAssignedTrip } from "../helpers/scenarios";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

async function linkFor(t: Awaited<ReturnType<typeof makeAssignedTrip>>) {
  const { token } = await createShareLink(t.logist, { tripId: t.tripId });
  const ctx = await ctxFromShareToken(db, token);
  if (!ctx) throw new Error("link should be valid");
  return { token, ctx };
}

describe("share links", () => {
  it("resolves a valid token to a driver context for that trip only", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    expect(ctx.orgId).toBe(t.org.orgId);
    expect(ctx.actor).toMatchObject({ kind: "driver_link", tripId: t.tripId });
  });

  it("stores only the hash of the token", async () => {
    const t = await makeAssignedTrip(db);
    const { token } = await linkFor(t);
    const rows = await db.select().from(shareLinks).where(eq(shareLinks.tripId, t.tripId));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("rejects an unknown token", async () => {
    expect(await ctxFromShareToken(db, "nope")).toBeNull();
    expect(await ctxFromShareToken(db, "")).toBeNull();
  });

  it("rejects an expired link", async () => {
    const t = await makeAssignedTrip(db);
    const { token } = await linkFor(t);
    await db.update(shareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLinks.tripId, t.tripId));
    expect(await ctxFromShareToken(db, token)).toBeNull();
  });

  it("rejects a revoked link", async () => {
    const t = await makeAssignedTrip(db);
    const { token } = await linkFor(t);
    const [link] = await listShareLinks(t.logist, t.tripId);
    await revokeShareLink(t.logist, link.id);
    expect(await ctxFromShareToken(db, token)).toBeNull();
  });

  it("rejects the link of a cancelled trip", async () => {
    const t = await makeAssignedTrip(db);
    const { token } = await linkFor(t);
    await transitionTrip(t.logist, { tripId: t.tripId, expectedVersion: (await getTrip(t.logist, t.tripId)).version, to: "cancelled", cancelReason: "Отмена" });
    expect(await ctxFromShareToken(db, token)).toBeNull();
  });

  it("is only created for a trip that has been planned", async () => {
    const t = await makeAssignedTrip(db);
    const other = await makeOrg(db);
    await expectCode(createShareLink(await other.as("logist"), { tripId: t.tripId }), "not_found");
    await expectCode(createShareLink(await t.org.as("warehouse"), { tripId: t.tripId }), "forbidden");
  });

  it("limits how long a link may live", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(createShareLink(t.logist, { tripId: t.tripId, ttlDays: 0 }), "validation");
    await expectCode(createShareLink(t.logist, { tripId: t.tripId, ttlDays: 400 }), "validation");
  });
});

describe("driver view", () => {
  it("shows stops, instructions and windows without any money field", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    const view = await getDriverView(ctx);

    expect(view.tripNumber).toBe(t.trip.number);
    expect(view.stops.map((s) => [s.seq, s.operation, s.name])).toEqual([
      [1, "load", "Склад"],
      [2, "unload", "Магазин А"],
      [3, "unload", "Магазин Б"],
    ]);
    expect(view.stops[0]).toMatchObject({ contact: "Кладовщик, +7 900 000-00-01", entryNotes: "Ворота 2" });
    expect(view.stops[1]).toMatchObject({ passRules: "Пропуск на КПП" });
    expect(view.stops[1].windowEnd).toBeInstanceOf(Date);
    expect(view.stops[1].plannedArriveAt).toBeInstanceOf(Date);
    expect(view.mapsUrl).toContain("https://yandex.ru/maps/");
    expect(view.navigatorUrl).toContain("yandexnavi://build_route_on_map");

    const text = JSON.stringify(view);
    for (const forbidden of ["Kop", "kop", "rate", "price", "cost", "total", "Rub"]) expect(text).not.toContain(forbidden);
  });

  it("is available only to a driver link", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(getDriverView(t.logist), "forbidden");
  });
});

describe("events", () => {
  it("lets the driver confirm without starting the trip; the first real event does", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    expect((await getTrip(t.logist, t.tripId)).status).toBe("assigned");

    await recordEvent(ctx, { tripId: t.tripId, type: "driver_confirmed" });
    // Confirming the assignment the evening before must not freeze the plan.
    expect((await getTrip(t.logist, t.tripId)).status).toBe("assigned");
    expect((await getDriverView(ctx)).confirmed).toBe(true);

    await recordEvent(ctx, { tripId: t.tripId, type: "loaded", stopId: t.trip.stops[0].id });
    expect((await getTrip(t.logist, t.tripId)).status).toBe("in_progress");
  });

  it("fills actual times on stops and completes the trip when every stop is resolved", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    const [load, a, b] = t.trip.stops;

    await recordEvent(ctx, { tripId: t.tripId, type: "loaded", stopId: load.id });
    await recordEvent(ctx, { tripId: t.tripId, type: "arrived", stopId: a.id });
    await recordEvent(ctx, { tripId: t.tripId, type: "unloaded", stopId: a.id });
    await recordEvent(ctx, { tripId: t.tripId, type: "arrived", stopId: b.id });
    expect((await getTrip(t.logist, t.tripId)).status).toBe("in_progress");
    await recordEvent(ctx, { tripId: t.tripId, type: "unloaded", stopId: b.id });

    const trip = await getTrip(t.logist, t.tripId);
    expect(trip.status).toBe("completed");
    expect(trip.stops.every((s) => s.actualArriveAt && s.actualDepartAt)).toBe(true);
  });

  it("ignores a repeated tap instead of overwriting the first time", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    const [, a] = t.trip.stops;
    await recordEvent(ctx, { tripId: t.tripId, type: "arrived", stopId: a.id });
    const first = (await getTrip(t.logist, t.tripId)).stops[1].actualArriveAt!;
    await new Promise((r) => setTimeout(r, 20));
    await recordEvent(ctx, { tripId: t.tripId, type: "arrived", stopId: a.id });

    expect((await getTrip(t.logist, t.tripId)).stops[1].actualArriveAt).toEqual(first);
    const count = await db.execute(sql`select count(*)::int as n from trip_event where trip_id = ${t.tripId}`);
    expect(count.rows[0].n).toBe(1);
  });

  it("uses the server clock for a driver, whatever time the page sends", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    await recordEvent(ctx, { tripId: t.tripId, type: "arrived", stopId: t.trip.stops[1].id, at: new Date("2020-01-01T00:00:00Z") });
    const arrived = (await getTrip(t.logist, t.tripId)).stops[1].actualArriveAt!;
    expect(arrived.getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("cannot record events for another trip", async () => {
    const t = await makeAssignedTrip(db);
    const other = await makeAssignedTrip(db, t.org);
    const { ctx } = await linkFor(t);
    await expectCode(recordEvent(ctx, { tripId: other.tripId, type: "driver_confirmed" }), "forbidden");
  });

  it("cannot record an event type reserved for staff", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    for (const type of ["departed", "loading_started", "stop_skipped", "completed", "fact_entered"] as const) {
      await expectCode(recordEvent(ctx, { tripId: t.tripId, type, stopId: t.trip.stops[1].id, skippedReason: "x" }), "forbidden");
    }
  });

  it("needs a stop for stop events and a stop of this trip", async () => {
    const t = await makeAssignedTrip(db);
    const other = await makeAssignedTrip(db, t.org);
    const { ctx } = await linkFor(t);
    await expectCode(recordEvent(ctx, { tripId: t.tripId, type: "arrived" }), "validation");
    await expectCode(recordEvent(ctx, { tripId: t.tripId, type: "arrived", stopId: other.trip.stops[1].id }), "not_found");
  });

  it("rejects events once the trip is completed", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    for (const stop of t.trip.stops) {
      await recordEvent(ctx, { tripId: t.tripId, type: stop.operation === "load" ? "loaded" : "unloaded", stopId: stop.id });
    }
    expect((await getTrip(t.logist, t.tripId)).status).toBe("completed");
    await expectCode(recordEvent(ctx, { tripId: t.tripId, type: "driver_confirmed" }), "trip_not_active");
  });

  it("lets staff mark a stop as not happening, with a reason, and still complete the trip", async () => {
    const t = await makeAssignedTrip(db);
    const [load, a, b] = t.trip.stops;
    const wh = await t.org.as("warehouse");

    await expectCode(recordEvent(wh, { tripId: t.tripId, type: "stop_skipped", stopId: b.id }), "validation");
    await recordEvent(wh, { tripId: t.tripId, type: "loaded", stopId: load.id });
    await recordEvent(wh, { tripId: t.tripId, type: "unloaded", stopId: a.id });
    await recordEvent(wh, { tripId: t.tripId, type: "stop_skipped", stopId: b.id, skippedReason: "Магазин закрыт" });

    const trip = await getTrip(t.logist, t.tripId);
    expect(trip.status).toBe("completed");
    expect(trip.stops[2].skippedReason).toBe("Магазин закрыт");
  });

  it("accepts staff events only from roles that may write execution", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(recordEvent(await t.org.as("finance"), { tripId: t.tripId, type: "driver_confirmed" }), "forbidden");
    await recordEvent(await t.org.as("warehouse"), { tripId: t.tripId, type: "driver_confirmed" });
  });
});

describe("event feed", () => {
  it("lists events newest first with the stop, the source and who reported", async () => {
    const t = await makeAssignedTrip(db);
    const { ctx } = await linkFor(t);
    await recordEvent(ctx, { tripId: t.tripId, type: "driver_confirmed" });
    await recordEvent(await t.org.as("warehouse"), { tripId: t.tripId, type: "loaded", stopId: t.trip.stops[0].id });
    await recordEvent(ctx, { tripId: t.tripId, type: "arrived", stopId: t.trip.stops[1].id });

    const events = await listTripEvents(t.logist, t.tripId);
    expect(events.map((e) => [e.type, e.stopName, e.source])).toEqual([
      ["arrived", "Магазин А", "link"],
      ["loaded", "Склад", "user"],
      ["driver_confirmed", null, "link"],
    ]);
    expect(events[1].actorName).toBe("warehouse");
    expect(events[0].actorName).toBe("Водитель по ссылке");
  });

  it("is isolated between organizations", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(listTripEvents(await (await makeOrg(db)).as("logist"), t.tripId), "not_found");
  });
});

describe("manual facts", () => {
  it("confirms the loaded quantity per cargo row", async () => {
    const t = await makeAssignedTrip(db);
    const cargo = t.trip.stops.flatMap((s) => s.cargo);
    const wh = await t.org.as("warehouse");
    await confirmLoading(wh, { tripId: t.tripId, items: [{ tripCargoId: cargo[0].id, loadedMilli: 4_000 }, { tripCargoId: cargo[1].id, loadedMilli: 5_000 }] });

    const loaded = (await getTrip(t.logist, t.tripId)).stops.flatMap((s) => s.cargo).map((c) => c.loadedMilli);
    expect(loaded).toEqual([4_000, 5_000]);
  });

  it("rejects a loaded quantity that is negative or belongs to another trip", async () => {
    const t = await makeAssignedTrip(db);
    const other = await makeAssignedTrip(db, t.org);
    const cargo = t.trip.stops.flatMap((s) => s.cargo)[0];
    await expectCode(confirmLoading(t.logist, { tripId: t.tripId, items: [{ tripCargoId: cargo.id, loadedMilli: -1 }] }), "validation");
    await expectCode(
      confirmLoading(t.logist, { tripId: t.tripId, items: [{ tripCargoId: other.trip.stops.flatMap((s) => s.cargo)[0].id, loadedMilli: 1_000 }] }),
      "not_found",
    );
  });

  it("enters actual stop times by hand and starts the trip", async () => {
    const t = await makeAssignedTrip(db);
    const [load, a] = t.trip.stops;
    await setStopFact(t.logist, { stopId: load.id, arriveAt: new Date("2026-11-12T02:50:00Z"), departAt: new Date("2026-11-12T03:20:00Z") });
    await setStopFact(t.logist, { stopId: a.id, arriveAt: new Date("2026-11-12T03:45:00Z") });

    const trip = await getTrip(t.logist, t.tripId);
    expect(trip.status).toBe("in_progress");
    expect(trip.stops[0].actualDepartAt?.toISOString()).toBe("2026-11-12T03:20:00.000Z");
    expect(trip.stops[1].actualDepartAt).toBeNull();
  });

  it("rejects a departure before the arrival", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(
      setStopFact(t.logist, { stopId: t.trip.stops[0].id, arriveAt: new Date("2026-11-12T03:00:00Z"), departAt: new Date("2026-11-12T02:00:00Z") }),
      "validation",
    );
  });

  it("records mileage, or that it is unknown", async () => {
    const t = await makeAssignedTrip(db);
    await setMileage(t.logist, { tripId: t.tripId, km: 23.7, unknown: false });
    expect(await getTrip(t.logist, t.tripId)).toMatchObject({ mileageKm: 23.7, mileageUnknown: false });
    await setMileage(t.logist, { tripId: t.tripId, km: null, unknown: true });
    expect(await getTrip(t.logist, t.tripId)).toMatchObject({ mileageKm: null, mileageUnknown: true });
    await expectCode(setMileage(t.logist, { tripId: t.tripId, km: -5, unknown: false }), "validation");
  });

  it("is isolated between organizations", async () => {
    const t = await makeAssignedTrip(db);
    const other = await makeOrg(db);
    await expectCode(setMileage(await other.as("logist"), { tripId: t.tripId, km: 1, unknown: false }), "not_found");
    await expectCode(setStopFact(await other.as("logist"), { stopId: t.trip.stops[0].id, arriveAt: new Date() }), "not_found");
  });
});
