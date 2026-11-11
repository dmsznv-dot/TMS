import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { yandexMapsRouteUrl, yandexNavigatorUrl } from "@/domain/yandexLinks";
import { requireCan, type Ctx } from "../auth/context";
import { planVersions, tripCargo, tripEvents, tripStops, trips, type TripEventType } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { tripFacts } from "./tripFacts";
import { loadTrip, lockTrip, moveTrip } from "./trips";
import { parseInput } from "./validation";

/** What a driver can report from the link. */
const DRIVER_EVENTS: TripEventType[] = ["driver_confirmed", "arrived", "loaded", "unloaded"];
/** Events that are about one stop. */
const STOP_EVENTS: TripEventType[] = ["arrived", "loaded", "unloaded", "stop_skipped", "departed", "loading_started"];
const WORKING = ["assigned", "in_progress"];
const FACT_EDITABLE = ["assigned", "in_progress", "completed"];

const EVENT_TYPES = [
  "driver_confirmed",
  "loading_started",
  "loaded",
  "departed",
  "arrived",
  "unloaded",
  "stop_skipped",
  "completed",
  "fact_entered",
] as const;

const eventInput = z.object({
  tripId: z.uuid(),
  type: z.enum(EVENT_TYPES),
  stopId: z.uuid().optional(),
  at: z.date().optional(),
  skippedReason: z.string().nullish(),
});

/** Completes an in-progress trip once every stop is resolved. */
async function completeIfResolved(ctx: Ctx, tripId: string): Promise<void> {
  const [trip] = await ctx.db.select({ status: trips.status }).from(trips).where(eq(trips.id, tripId));
  if (trip?.status !== "in_progress") return;
  if ((await tripFacts(ctx, tripId)).allStopsResolved) await moveTrip(ctx, tripId, "completed");
}

/**
 * Records something that happened on the trip and applies it to the stops.
 * A driver link may report only its own trip and only the driver's events;
 * its time is the server's. The first event starts the trip; resolving every
 * stop completes it. Repeating an event changes nothing.
 */
export async function recordEvent(
  ctx: Ctx,
  input: z.input<typeof eventInput>,
): Promise<{ recorded: boolean }> {
  const data = parseInput(eventInput, input);
  const isLink = ctx.actor.kind === "driver_link";

  if (ctx.actor.kind === "driver_link") {
    if (ctx.actor.tripId !== data.tripId || !DRIVER_EVENTS.includes(data.type)) {
      throw new DomainError("forbidden", "Это действие недоступно по ссылке водителя");
    }
  } else {
    requireCan(ctx, "execution.write");
  }

  if (STOP_EVENTS.includes(data.type) && !data.stopId) throw new DomainError("validation", "Укажите остановку");
  if (data.type === "stop_skipped" && !(data.skippedReason ?? "").trim()) {
    throw new DomainError("validation", "Укажите, почему остановка не состоялась");
  }

  return inTransaction(ctx, async (tx) => {
    const trip = await lockTrip(tx, data.tripId, undefined, null);
    if (!WORKING.includes(trip.status)) {
      throw new DomainError("trip_not_active", "Рейс не принимает отметок: он ещё не назначен или уже завершён");
    }

    if (data.stopId) {
      const [stop] = await tx.db
        .select({ id: tripStops.id })
        .from(tripStops)
        .where(and(eq(tripStops.id, data.stopId), eq(tripStops.tripId, data.tripId), eq(tripStops.orgId, tx.orgId)));
      if (!stop) throw new DomainError("not_found", "Остановка не найдена в этом рейсе");
    }

    const earlier = await tx.db
      .select({ id: tripEvents.id, stopId: tripEvents.stopId })
      .from(tripEvents)
      .where(and(eq(tripEvents.tripId, data.tripId), eq(tripEvents.type, data.type)));
    if (earlier.some((e) => (e.stopId ?? undefined) === data.stopId)) return { recorded: false };

    const now = new Date();
    const at = isLink ? now : (data.at ?? now);
    await tx.db.insert(tripEvents).values({
      orgId: tx.orgId,
      tripId: data.tripId,
      stopId: data.stopId ?? null,
      type: data.type,
      at,
      source: isLink ? "link" : "user",
      actorId: tx.actor.kind === "user" ? tx.actor.userId : tx.actor.linkId,
    });

    if (data.stopId) {
      const [stop] = await tx.db.select().from(tripStops).where(eq(tripStops.id, data.stopId));
      const set: Partial<typeof tripStops.$inferInsert> = {};
      if (data.type === "arrived" && !stop.actualArriveAt) set.actualArriveAt = at;
      if (data.type === "loaded" || data.type === "unloaded" || data.type === "departed") {
        if (!stop.actualArriveAt) set.actualArriveAt = at;
        if (!stop.actualDepartAt) set.actualDepartAt = at;
      }
      if (data.type === "stop_skipped") set.skippedReason = data.skippedReason!.trim();
      if (Object.keys(set).length > 0) await tx.db.update(tripStops).set(set).where(eq(tripStops.id, data.stopId));
    }

    if (trip.status === "assigned") await moveTrip(tx, data.tripId, "in_progress");
    if (data.type === "completed") await moveTrip(tx, data.tripId, "completed");
    else await completeIfResolved(tx, data.tripId);

    await audit(tx, { entity: "trip", entityId: data.tripId, action: `event:${data.type}`, after: { stopId: data.stopId, at } });
    return { recorded: true };
  });
}

const loadingInput = z.object({
  tripId: z.uuid(),
  items: z
    .array(z.object({ tripCargoId: z.uuid(), loadedMilli: z.number().int().nonnegative("Количество не может быть отрицательным") }))
    .min(1),
});

/** Records how much of each cargo row was actually loaded. */
export async function confirmLoading(ctx: Ctx, input: z.input<typeof loadingInput>): Promise<void> {
  requireCan(ctx, "execution.write");
  const data = parseInput(loadingInput, input);
  await inTransaction(ctx, async (tx) => {
    const trip = await lockTrip(tx, data.tripId, undefined, null);
    if (!WORKING.includes(trip.status)) throw new DomainError("trip_not_active", "Погрузку фиксируют по назначенному рейсу");
    for (const item of data.items) {
      const updated = await tx.db
        .update(tripCargo)
        .set({ loadedMilli: item.loadedMilli })
        .where(and(eq(tripCargo.id, item.tripCargoId), eq(tripCargo.tripId, data.tripId), eq(tripCargo.orgId, tx.orgId)))
        .returning({ id: tripCargo.id });
      if (updated.length === 0) throw new DomainError("not_found", "Груз не найден в этом рейсе");
    }
    await audit(tx, { entity: "trip", entityId: data.tripId, action: "confirm_loading", after: data.items });
  });
}

const factInput = z.object({ stopId: z.uuid(), arriveAt: z.date().optional(), departAt: z.date().optional() });

/** Enters actual arrival and departure times by hand, as a correction or when no one reported them. */
export async function setStopFact(ctx: Ctx, input: z.input<typeof factInput>): Promise<void> {
  requireCan(ctx, "execution.write");
  const data = parseInput(factInput, input);
  await inTransaction(ctx, async (tx) => {
    const [stop] = await tx.db
      .select()
      .from(tripStops)
      .where(and(eq(tripStops.id, data.stopId), eq(tripStops.orgId, tx.orgId)));
    if (!stop) throw new DomainError("not_found", "Остановка не найдена");

    const trip = await lockTrip(tx, stop.tripId, undefined, null);
    if (!FACT_EDITABLE.includes(trip.status)) {
      throw new DomainError("trip_not_active", "Факт вносят по назначенному или выполненному рейсу");
    }
    const arrive = data.arriveAt ?? stop.actualArriveAt;
    const depart = data.departAt ?? stop.actualDepartAt;
    if (arrive && depart && depart < arrive) throw new DomainError("validation", "Отъезд раньше прибытия");

    await tx.db
      .update(tripStops)
      .set({ actualArriveAt: arrive, actualDepartAt: depart })
      .where(eq(tripStops.id, stop.id));
    await tx.db.insert(tripEvents).values({
      orgId: tx.orgId,
      tripId: stop.tripId,
      stopId: stop.id,
      type: "fact_entered",
      at: new Date(),
      source: "user",
      actorId: tx.actor.kind === "user" ? tx.actor.userId : null,
    });
    if (trip.status === "assigned") await moveTrip(tx, stop.tripId, "in_progress");
    await completeIfResolved(tx, stop.tripId);
    await audit(tx, { entity: "trip_stop", entityId: stop.id, action: "fact", before: { arrive: stop.actualArriveAt, depart: stop.actualDepartAt }, after: { arrive, depart } });
  });
}

const mileageInput = z.object({
  tripId: z.uuid(),
  km: z.number().nonnegative("Пробег не может быть отрицательным").nullable(),
  unknown: z.boolean(),
});

/** Actual mileage of the trip, or a mark that it is unknown. */
export async function setMileage(ctx: Ctx, input: z.input<typeof mileageInput>): Promise<void> {
  requireCan(ctx, "execution.write");
  const data = parseInput(mileageInput, input);
  if (!data.unknown && data.km == null) throw new DomainError("validation", "Укажите пробег или отметьте, что он неизвестен");
  await inTransaction(ctx, async (tx) => {
    const trip = await lockTrip(tx, data.tripId, undefined, null);
    if (!FACT_EDITABLE.includes(trip.status)) throw new DomainError("trip_not_active", "Пробег вносят по назначенному или выполненному рейсу");
    await tx.db
      .update(trips)
      .set({ mileageKm: data.unknown ? null : data.km, mileageUnknown: data.unknown })
      .where(eq(trips.id, data.tripId));
    await audit(tx, { entity: "trip", entityId: data.tripId, action: "mileage", after: { km: data.km, unknown: data.unknown } });
  });
}

// --- what the driver sees ----------------------------------------------------

export type DriverStopView = {
  id: string;
  seq: number;
  operation: "load" | "unload" | "return";
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  tz: string;
  contact: string | null;
  entryNotes: string | null;
  passRules: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  plannedArriveAt: Date | null;
  actualArriveAt: Date | null;
  actualDepartAt: Date | null;
  skippedReason: string | null;
  cargo: { product: string | null; unit: string | null; qtyMilli: number }[];
};

export type DriverView = {
  tripNumber: string;
  status: string;
  confirmed: boolean;
  /** False once the trip no longer takes reports. */
  canReport: boolean;
  stops: DriverStopView[];
  mapsUrl: string;
  navigatorUrl: string;
};

/** The trip as the driver sees it: places, times, instructions and cargo, with no money. */
export async function getDriverView(ctx: Ctx): Promise<DriverView> {
  if (ctx.actor.kind !== "driver_link") throw new DomainError("forbidden", "Доступно только по ссылке водителя");
  const tripId = ctx.actor.tripId;
  const trip = await loadTrip(ctx, tripId);

  const [plan] = await ctx.db
    .select({ stops: planVersions.stopsSnapshot })
    .from(planVersions)
    .where(and(eq(planVersions.tripId, tripId), eq(planVersions.orgId, ctx.orgId), eq(planVersions.isCurrent, true)));
  const planned = new Map((plan?.stops ?? []).map((s) => [s.stopId, s.arriveAt]));

  const events = await ctx.db
    .select({ type: tripEvents.type })
    .from(tripEvents)
    .where(and(eq(tripEvents.tripId, tripId), eq(tripEvents.type, "driver_confirmed"), eq(tripEvents.orgId, ctx.orgId)))
    .orderBy(asc(tripEvents.at));

  const stops: DriverStopView[] = trip.stops.map((s) => ({
    id: s.id,
    seq: s.seq,
    operation: s.operation,
    name: s.location.name,
    address: s.location.address,
    lat: s.location.lat,
    lon: s.location.lon,
    tz: s.location.tz,
    contact: s.location.contact,
    entryNotes: s.location.entryNotes,
    passRules: s.location.passRules,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    plannedArriveAt: planned.get(s.id) ? new Date(planned.get(s.id)!) : null,
    actualArriveAt: s.actualArriveAt,
    actualDepartAt: s.actualDepartAt,
    skippedReason: s.skippedReason,
    cargo: s.cargo.map((c) => ({ product: c.product, unit: c.unit, qtyMilli: c.qtyMilli })),
  }));

  // The route goes to each stop's entry point when it has one, as the planning did.
  const points = trip.stops.map((s) =>
    s.location.entryLat != null && s.location.entryLon != null
      ? { lat: s.location.entryLat, lon: s.location.entryLon }
      : { lat: s.location.lat, lon: s.location.lon },
  );

  return {
    tripNumber: trip.number,
    status: trip.status,
    confirmed: events.length > 0,
    canReport: WORKING.includes(trip.status),
    stops,
    mapsUrl: yandexMapsRouteUrl(points),
    navigatorUrl: yandexNavigatorUrl(points),
  };
}
