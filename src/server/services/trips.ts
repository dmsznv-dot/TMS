import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { checkAllocation, remainingToPlan } from "@/domain/allocation";
import { checkTransition, type TripStatus } from "@/domain/tripStatus";
import { requireCan, type Ctx } from "../auth/context";
import { locations, orderLines, orders, tripCargo, tripStops, trips } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { lineProgress } from "./orders";
import { tripFacts } from "./tripFacts";
import { parseInput } from "./validation";

export const MAX_STOPS = 10;
const EDITABLE: TripStatus[] = ["draft", "planned"];

type TripRow = typeof trips.$inferSelect;

const TRANSITION_MESSAGES: Record<string, string> = {
  invalid_transition: "Такой переход статуса недоступен",
  no_cargo: "В рейсе нет груза",
  no_plan: "У рейса нет сохранённого плана",
  executor_not_ready: "Не назначена машина с водителем или не подтверждено предложение подрядчика",
  no_execution_event: "По рейсу ещё нет отметок исполнения",
  stops_unresolved: "По некоторым остановкам нет фактического времени или причины, почему они не состоялись",
  incomplete: "Данные рейса неполны. Укажите причину, чтобы закрыть его так.",
  cancel_reason_required: "Укажите причину отмены",
};

// --- locking -----------------------------------------------------------------

/** Loads the trip with a row lock and checks the caller's version. */
async function lockTrip(ctx: Ctx, tripId: string, expectedVersion: number | undefined, editable = true): Promise<TripRow> {
  const [trip] = await ctx.db
    .select()
    .from(trips)
    .where(and(eq(trips.id, tripId), eq(trips.orgId, ctx.orgId)))
    .for("update");
  if (!trip) throw new DomainError("not_found", "Рейс не найден");
  if (expectedVersion !== undefined && trip.version !== expectedVersion) {
    throw new DomainError("stale", "Рейс уже изменили. Обновите страницу и повторите действие.");
  }
  if (editable && !EDITABLE.includes(trip.status)) {
    throw new DomainError("trip_locked", "Рейс нельзя менять в этом статусе");
  }
  return trip;
}

async function bumpVersion(ctx: Ctx, tripId: string): Promise<number> {
  const [row] = await ctx.db
    .update(trips)
    .set({ version: sql`${trips.version} + 1` })
    .where(eq(trips.id, tripId))
    .returning({ version: trips.version });
  return row.version;
}

async function resequence(ctx: Ctx, tripId: string): Promise<void> {
  const stops = await ctx.db
    .select({ id: tripStops.id })
    .from(tripStops)
    .where(eq(tripStops.tripId, tripId))
    .orderBy(asc(tripStops.seq));
  for (let i = 0; i < stops.length; i++) {
    await ctx.db.update(tripStops).set({ seq: i + 1 }).where(eq(tripStops.id, stops[i].id));
  }
}

// --- creating and editing ----------------------------------------------------

export async function createTrip(ctx: Ctx, input: { originLocationId: string }): Promise<{ tripId: string; number: string }> {
  requireCan(ctx, "planning.write");
  const { originLocationId } = parseInput(z.object({ originLocationId: z.uuid() }), input);

  return inTransaction(ctx, async (tx) => {
    const [origin] = await tx.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, originLocationId), eq(locations.orgId, tx.orgId)));
    if (!origin) throw new DomainError("location_not_found", "Точка погрузки не найдена");

    // Numbers are sequential per organization; the lock keeps concurrent creators apart.
    await tx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${tx.orgId}))`);
    const [{ n }] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(trips)
      .where(eq(trips.orgId, tx.orgId));
    const number = `Р-${String(n + 1).padStart(4, "0")}`;

    const [trip] = await tx.db.insert(trips).values({ orgId: tx.orgId, number }).returning({ id: trips.id });
    await tx.db.insert(tripStops).values({
      orgId: tx.orgId,
      tripId: trip.id,
      seq: 1,
      locationId: originLocationId,
      operation: "load",
    });
    await audit(tx, { entity: "trip", entityId: trip.id, action: "create", after: { number } });
    return { tripId: trip.id, number };
  });
}

const addItemsSchema = z
  .array(
    z.object({
      orderLineId: z.uuid(),
      qtyMilli: z.number().int().positive("Количество должно быть больше нуля"),
    }),
  )
  .min(1, "Выберите, что добавить в рейс");

/**
 * Puts quantities of order lines on the trip, adding an unloading stop for
 * each new delivery point. All items are added or none.
 */
export async function addOrderToTrip(
  ctx: Ctx,
  input: { tripId: string; expectedVersion: number; items: { orderLineId: string; qtyMilli: number }[] },
): Promise<{ version: number }> {
  requireCan(ctx, "planning.write");
  const items = parseInput(addItemsSchema, input.items);

  // The same line twice in one request is the sum of both.
  const wanted = new Map<string, number>();
  for (const item of items) wanted.set(item.orderLineId, (wanted.get(item.orderLineId) ?? 0) + item.qtyMilli);
  const lineIds = [...wanted.keys()].sort();

  return inTransaction(ctx, async (tx) => {
    const trip = await lockTrip(tx, input.tripId, input.expectedVersion);

    // Lines are locked in a fixed order so two planners never wait on each other in a cycle.
    const lines = await tx.db
      .select({ id: orderLines.id, qty: orderLines.qtyMilli, orderId: orderLines.orderId })
      .from(orderLines)
      .where(and(eq(orderLines.orgId, tx.orgId), inArray(orderLines.id, lineIds)))
      .orderBy(orderLines.id)
      .for("update");
    if (lines.length !== lineIds.length) throw new DomainError("not_found", "Строка заказа не найдена");

    const orderRows = await tx.db
      .select({ id: orders.id, number: orders.number, locationId: orders.locationId, cancelled: orders.cancelled })
      .from(orders)
      .where(inArray(orders.id, [...new Set(lines.map((l) => l.orderId))]));
    const orderById = new Map(orderRows.map((o) => [o.id, o]));

    // Read after the lock: a concurrent planner's committed allocation is visible here.
    const progress = await lineProgress(tx, lineIds);
    for (const line of lines) {
      const order = orderById.get(line.orderId)!;
      if (order.cancelled) throw new DomainError("order_cancelled", `Заказ ${order.number} отменён`);
      const { allocatedOpen, delivered } = progress.get(line.id)!;
      const check = checkAllocation(remainingToPlan({ qty: line.qty, allocatedOpen, delivered }), wanted.get(line.id)!);
      if (!check.ok) {
        throw new DomainError(
          check.code,
          check.code === "exceeds_remaining"
            ? `По заказу ${order.number} не хватает остатка для планирования`
            : "Количество должно быть больше нуля",
        );
      }
    }

    const stops = await tx.db.select().from(tripStops).where(eq(tripStops.tripId, trip.id)).orderBy(asc(tripStops.seq));
    let nextSeq = stops.length === 0 ? 1 : stops[stops.length - 1].seq + 1;
    let stopCount = stops.length;
    const unloadByLocation = new Map(stops.filter((s) => s.operation === "unload").map((s) => [s.locationId, s.id]));

    // Stops follow the order the planner added the lines in, not the lock order.
    const lineById = new Map(lines.map((l) => [l.id, l]));
    for (const lineId of wanted.keys()) {
      const line = lineById.get(lineId)!;
      const order = orderById.get(line.orderId)!;
      let stopId = unloadByLocation.get(order.locationId);
      if (!stopId) {
        if (stopCount >= MAX_STOPS) {
          throw new DomainError("too_many_stops", `В рейсе не может быть больше ${MAX_STOPS} остановок (в API 2ГИС — до 10 точек)`);
        }
        const [stop] = await tx.db
          .insert(tripStops)
          .values({ orgId: tx.orgId, tripId: trip.id, seq: nextSeq++, locationId: order.locationId, operation: "unload" })
          .returning({ id: tripStops.id });
        stopId = stop.id;
        unloadByLocation.set(order.locationId, stopId);
        stopCount++;
      }
      await tx.db
        .insert(tripCargo)
        .values({ orgId: tx.orgId, tripId: trip.id, stopId, orderLineId: line.id, qtyMilli: wanted.get(line.id)! })
        .onConflictDoUpdate({
          target: [tripCargo.stopId, tripCargo.orderLineId],
          set: { qtyMilli: sql`${tripCargo.qtyMilli} + ${wanted.get(line.id)!}` },
        });
    }

    const version = await bumpVersion(tx, trip.id);
    await audit(tx, {
      entity: "trip",
      entityId: trip.id,
      action: "add_cargo",
      after: Object.fromEntries(wanted),
    });
    return { version };
  });
}

export async function removeCargo(
  ctx: Ctx,
  input: { tripId: string; expectedVersion: number; tripCargoId: string },
): Promise<{ version: number }> {
  requireCan(ctx, "planning.write");
  return inTransaction(ctx, async (tx) => {
    const trip = await lockTrip(tx, input.tripId, input.expectedVersion);
    const [cargo] = await tx.db
      .select()
      .from(tripCargo)
      .where(and(eq(tripCargo.id, input.tripCargoId), eq(tripCargo.tripId, trip.id), eq(tripCargo.orgId, tx.orgId)));
    if (!cargo) throw new DomainError("not_found", "Груз не найден в рейсе");

    await tx.db.delete(tripCargo).where(eq(tripCargo.id, cargo.id));
    const [{ left }] = await tx.db
      .select({ left: sql<number>`count(*)::int` })
      .from(tripCargo)
      .where(eq(tripCargo.stopId, cargo.stopId));
    if (left === 0) {
      await tx.db.delete(tripStops).where(and(eq(tripStops.id, cargo.stopId), eq(tripStops.operation, "unload")));
      await resequence(tx, trip.id);
    }

    const version = await bumpVersion(tx, trip.id);
    await audit(tx, { entity: "trip", entityId: trip.id, action: "remove_cargo", before: { orderLineId: cargo.orderLineId, qtyMilli: cargo.qtyMilli } });
    return { version };
  });
}

export async function reorderStops(
  ctx: Ctx,
  input: { tripId: string; expectedVersion: number; stopIds: string[] },
): Promise<{ version: number }> {
  requireCan(ctx, "planning.write");
  return inTransaction(ctx, async (tx) => {
    const trip = await lockTrip(tx, input.tripId, input.expectedVersion);
    const stops = await tx.db.select().from(tripStops).where(eq(tripStops.tripId, trip.id));

    const sameSet =
      input.stopIds.length === stops.length &&
      new Set(input.stopIds).size === stops.length &&
      stops.every((s) => input.stopIds.includes(s.id));
    if (!sameSet) throw new DomainError("validation", "Список остановок должен содержать каждую остановку рейса ровно один раз");
    const first = stops.find((s) => s.id === input.stopIds[0])!;
    if (first.operation !== "load") throw new DomainError("validation", "Рейс должен начинаться с погрузки");

    for (let i = 0; i < input.stopIds.length; i++) {
      await tx.db.update(tripStops).set({ seq: i + 1 }).where(eq(tripStops.id, input.stopIds[i]));
    }
    const version = await bumpVersion(tx, trip.id);
    await audit(tx, { entity: "trip", entityId: trip.id, action: "reorder_stops", after: input.stopIds });
    return { version };
  });
}

// --- status ------------------------------------------------------------------

export type MoveOptions = { expectedVersion?: number; cancelReason?: string | null; overrideReason?: string | null };

/**
 * Moves a trip to another status when the rules allow it. Runs inside the
 * caller's transaction and does no permission check, so execution events
 * that come from a driver link can use it too.
 */
export async function moveTrip(ctx: Ctx, tripId: string, to: TripStatus, options: MoveOptions = {}): Promise<{ version: number }> {
  const trip = await lockTrip(ctx, tripId, options.expectedVersion, false);
  const facts = await tripFacts(ctx, tripId);
  const check = checkTransition(trip.status, to, {
    ...facts,
    cancelReason: options.cancelReason ?? null,
    overrideReason: options.overrideReason ?? null,
  });
  if (!check.ok) throw new DomainError(check.code, TRANSITION_MESSAGES[check.code] ?? "Переход недоступен");

  const [row] = await ctx.db
    .update(trips)
    .set({
      status: to,
      version: sql`${trips.version} + 1`,
      ...(to === "cancelled" ? { cancelReason: options.cancelReason?.trim() } : {}),
      ...(to === "closed" ? { closedAt: new Date(), closeOverrideReason: options.overrideReason?.trim() || null } : {}),
    })
    .where(eq(trips.id, tripId))
    .returning({ version: trips.version });
  await audit(ctx, {
    entity: "trip",
    entityId: tripId,
    action: "status",
    before: { status: trip.status },
    after: { status: to, cancelReason: options.cancelReason, overrideReason: options.overrideReason },
  });
  return row;
}

export async function transitionTrip(
  ctx: Ctx,
  input: { tripId: string; expectedVersion: number; to: TripStatus; cancelReason?: string; overrideReason?: string },
): Promise<{ version: number }> {
  requireCan(
    ctx,
    input.to === "closed" ? "trip.close" : input.to === "in_progress" || input.to === "completed" ? "execution.write" : "planning.write",
  );
  return inTransaction(ctx, (tx) =>
    moveTrip(tx, input.tripId, input.to, {
      expectedVersion: input.expectedVersion,
      cancelReason: input.cancelReason,
      overrideReason: input.overrideReason,
    }),
  );
}

// --- reading -----------------------------------------------------------------

export type TripCargoView = {
  id: string;
  orderLineId: string;
  orderId: string;
  orderNumber: string;
  product: string | null;
  unit: string | null;
  qtyMilli: number;
  loadedMilli: number | null;
};

export type TripStopView = {
  id: string;
  seq: number;
  operation: "load" | "unload" | "return";
  location: {
    id: string;
    name: string;
    address: string | null;
    lat: number;
    lon: number;
    tz: string;
    serviceMin: number;
    entryLat: number | null;
    entryLon: number | null;
    entryNotes: string | null;
    passRules: string | null;
    contact: string | null;
  };
  /** The tightest window of the orders delivered here; null for stops without orders. */
  windowStart: Date | null;
  windowEnd: Date | null;
  actualArriveAt: Date | null;
  actualDepartAt: Date | null;
  skippedReason: string | null;
  cargo: TripCargoView[];
};

export type TripView = {
  id: string;
  number: string;
  status: TripStatus;
  version: number;
  cancelReason: string | null;
  baselinePlanVersionId: string | null;
  mileageKm: number | null;
  mileageUnknown: boolean;
  closeOverrideReason: string | null;
  createdAt: Date;
  closedAt: Date | null;
  stops: TripStopView[];
};

export async function getTrip(ctx: Ctx, tripId: string): Promise<TripView> {
  requireCan(ctx, "trips.read");
  const [trip] = await ctx.db.select().from(trips).where(and(eq(trips.id, tripId), eq(trips.orgId, ctx.orgId)));
  if (!trip) throw new DomainError("not_found", "Рейс не найден");

  const stopRows = await ctx.db
    .select({ stop: tripStops, location: locations })
    .from(tripStops)
    .innerJoin(locations, eq(locations.id, tripStops.locationId))
    .where(eq(tripStops.tripId, tripId))
    .orderBy(asc(tripStops.seq));

  const cargoRows = await ctx.db
    .select({
      cargo: tripCargo,
      orderId: orders.id,
      orderNumber: orders.number,
      windowStart: orders.windowStart,
      windowEnd: orders.windowEnd,
      product: orderLines.product,
      unit: orderLines.unit,
    })
    .from(tripCargo)
    .innerJoin(orderLines, eq(orderLines.id, tripCargo.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(tripCargo.tripId, tripId))
    .orderBy(asc(orders.number), asc(orderLines.lineKey));

  const stops: TripStopView[] = stopRows.map(({ stop, location }) => {
    const here = cargoRows.filter((c) => c.cargo.stopId === stop.id);
    const starts = here.map((c) => c.windowStart.getTime());
    const ends = here.map((c) => c.windowEnd.getTime());
    return {
      id: stop.id,
      seq: stop.seq,
      operation: stop.operation,
      location: {
        id: location.id,
        name: location.name,
        address: location.address,
        lat: location.lat,
        lon: location.lon,
        tz: location.tz,
        serviceMin: location.serviceMin,
        entryLat: location.entryLat,
        entryLon: location.entryLon,
        entryNotes: location.entryNotes,
        passRules: location.passRules,
        contact: location.contact,
      },
      windowStart: here.length > 0 ? new Date(Math.max(...starts)) : null,
      windowEnd: here.length > 0 ? new Date(Math.min(...ends)) : null,
      actualArriveAt: stop.actualArriveAt,
      actualDepartAt: stop.actualDepartAt,
      skippedReason: stop.skippedReason,
      cargo: here.map((c) => ({
        id: c.cargo.id,
        orderLineId: c.cargo.orderLineId,
        orderId: c.orderId,
        orderNumber: c.orderNumber,
        product: c.product,
        unit: c.unit,
        qtyMilli: c.cargo.qtyMilli,
        loadedMilli: c.cargo.loadedMilli,
      })),
    };
  });

  return {
    id: trip.id,
    number: trip.number,
    status: trip.status,
    version: trip.version,
    cancelReason: trip.cancelReason,
    baselinePlanVersionId: trip.baselinePlanVersionId,
    mileageKm: trip.mileageKm,
    mileageUnknown: trip.mileageUnknown,
    closeOverrideReason: trip.closeOverrideReason,
    createdAt: trip.createdAt,
    closedAt: trip.closedAt,
    stops,
  };
}

export type TripListItem = {
  id: string;
  number: string;
  status: TripStatus;
  createdAt: Date;
  stopCount: number;
  cargoCount: number;
};

export async function listTrips(
  ctx: Ctx,
  filter: { status?: TripStatus; from?: Date; to?: Date } = {},
): Promise<TripListItem[]> {
  requireCan(ctx, "trips.read");
  const conditions = [eq(trips.orgId, ctx.orgId)];
  if (filter.status) conditions.push(eq(trips.status, filter.status));
  if (filter.from) conditions.push(gte(trips.createdAt, filter.from));
  if (filter.to) conditions.push(lte(trips.createdAt, filter.to));

  return ctx.db
    .select({
      id: trips.id,
      number: trips.number,
      status: trips.status,
      createdAt: trips.createdAt,
      stopCount: sql<number>`(select count(*)::int from trip_stop where trip_stop.trip_id = ${trips.id})`,
      cargoCount: sql<number>`(select count(*)::int from trip_cargo where trip_cargo.trip_id = ${trips.id})`,
    })
    .from(trips)
    .where(and(...conditions))
    .orderBy(desc(trips.createdAt), desc(trips.number))
    .limit(500);
}
