import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { buildComparison, type ComparisonRow, type Option } from "@/domain/comparison";
import { estimateCarrier, estimateOwn, type CostEstimate, type TollState } from "@/domain/costEstimate";
import { DomainError } from "@/domain/errors";
import { type StopInput, type StopPlan, computeStopPlans } from "@/domain/eta";
import { apportion, haversineM, type LatLon } from "@/domain/geo";
import { formatInTz } from "@/domain/time";
import { isTruckProfileComplete } from "@/domain/truck";
import { requireCan, type Ctx } from "../auth/context";
import {
  carrierOffers,
  counterparties,
  drivers,
  orderLines,
  planVersions,
  tripCargo,
  trips,
  users,
  vehicles,
  type PlanStopSnapshot,
} from "../db/schema";
import { env } from "../env";
import { getQuota, recordRoutingRequest, type Quota } from "../routing/quota";
import { getRoutingProvider } from "../routing";
import { validatePoints, type RouteFailure, type RouteVariant, type RoutingProvider } from "../routing/types";
import { openVariant, sealVariant, type SealedVariant } from "../routing/variantToken";
import { audit, inTransaction } from "./audit";
import { loadOffers, type OfferView } from "./offers";
import { getDriver, getVehicle, listVehicles, truckProfileOf, type VehicleRow } from "./refs";
import { bumpVersion, getTrip, lockTrip, moveTrip, type TripView } from "./trips";
import { getOrgSettings } from "./users";
import { parseInput } from "./validation";

/** The demo key of 2GIS builds routes only between points up to this far apart. */
const DEMO_KEY_MAX_LEG_M = 50_000;
const PLANNABLE = ["draft", "planned", "assigned"] as const;

const tollSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("amount"), kop: z.number().int().nonnegative() }),
]);

// --- shared pieces -----------------------------------------------------------

function routePoints(trip: TripView): LatLon[] {
  return trip.stops.map((s) =>
    s.location.entryLat != null && s.location.entryLon != null
      ? { lat: s.location.entryLat, lon: s.location.entryLon }
      : { lat: s.location.lat, lon: s.location.lon },
  );
}

/** The stops after the loading point, as the timeline needs them. */
function stopInputs(trip: TripView): StopInput[] {
  return trip.stops.slice(1).map((s) => ({
    serviceMin: s.location.serviceMin,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
  }));
}

function straightLegsM(points: LatLon[]): number[] {
  return points.slice(1).map((p, i) => haversineM(points[i], p));
}

/** A carrier that confirmed an arrival time fixes the whole timeline; otherwise the planned departure is used. */
function departureFor(departureAt: Date, legDurationsS: number[], offer: OfferView | null): Date {
  if (!offer?.confirmedArriveAt) return departureAt;
  return new Date(offer.confirmedArriveAt.getTime() - legDurationsS[0] * 1000);
}

function timeline(trip: TripView, departureAt: Date, legDurationsS: number[], bufferMin: number): StopPlan[] {
  if (legDurationsS.length !== trip.stops.length - 1) {
    throw new DomainError("variant_stale", "Состав рейса изменился после расчёта маршрута. Рассчитайте маршрут заново.");
  }
  return computeStopPlans(departureAt, legDurationsS, stopInputs(trip), bufferMin);
}

const lastDeparture = (plans: StopPlan[], fallback: Date) => (plans.length > 0 ? plans[plans.length - 1].departAt : fallback);

function openSealed(token: string): SealedVariant {
  const sealed = openVariant(token);
  if (!sealed) throw new DomainError("variant_expired", "Расчёт маршрута устарел. Рассчитайте маршрут заново.");
  return sealed;
}

function resolveToll(toll: TollState, tollFiltered: boolean): TollState {
  return toll.kind === "unknown" && tollFiltered ? { kind: "none" } : toll;
}

// --- calculating routes ------------------------------------------------------

export type ClientVariant = RouteVariant & {
  /** Carries the numbers of this variant back to the server, signed. */
  token: string;
  stops: StopPlan[];
  tollFiltered: boolean;
  profileComplete: boolean;
};

export type CalculateResult = {
  result: { ok: true; variants: ClientVariant[] } | { ok: false; reason: RouteFailure; message: string };
  quota: Quota;
  warnings: string[];
  /** True when the request was held back until the planner confirms it. */
  needsConfirmation: boolean;
};

const calculateInput = z.object({
  tripId: z.uuid(),
  departureAt: z.date(),
  vehicleId: z.uuid().nullable(),
  avoidToll: z.boolean(),
  confirmFar: z.boolean().optional(),
});

/**
 * Asks the routing provider for variants for the trip's stops and works out
 * arrival times against the delivery windows. Nothing is stored except a
 * log line; the route geometry only travels to the screen.
 */
export async function calculateRoutes(
  ctx: Ctx,
  input: z.input<typeof calculateInput>,
  deps: { provider?: RoutingProvider } = {},
): Promise<CalculateResult> {
  requireCan(ctx, "routing.calculate");
  const data = parseInput(calculateInput, input);
  const trip = await getTrip(ctx, data.tripId);
  if (!(PLANNABLE as readonly string[]).includes(trip.status)) {
    throw new DomainError("trip_locked", "Для этого рейса маршрут уже не рассчитывается");
  }

  const live = env.ROUTING_MODE === "live";
  const quota = await getQuota(ctx);
  const warnings: string[] = [];
  const held = (result: CalculateResult["result"], needsConfirmation = false): CalculateResult => ({
    result,
    quota,
    warnings,
    needsConfirmation,
  });

  const points = routePoints(trip);
  const invalid = validatePoints(points);
  if (invalid && !invalid.ok) {
    const message = points.length < 2 ? "В рейсе нет остановок с грузом: рассчитывать нечего" : invalid.message;
    return held({ ok: false, reason: invalid.reason, message });
  }

  if (live) {
    if (quota.used >= quota.limit) {
      return held({ ok: false, reason: "quota", message: `Лимит запросов 2ГИС исчерпан: использовано ${quota.used} из ${quota.limit}` });
    }
    const legs = straightLegsM(points);
    const far = legs.findIndex((m) => m > DEMO_KEY_MAX_LEG_M);
    if (far >= 0) {
      const km = Math.round(legs[far] / 1000);
      warnings.push(
        `Между точками «${trip.stops[far].location.name}» и «${trip.stops[far + 1].location.name}» около ${km} км по прямой. ` +
          "Демо-ключ 2ГИС строит маршруты только между точками до 50 км, запрос, вероятно, будет отклонён и спишет попытку.",
      );
      if (!data.confirmFar) {
        return held({ ok: false, reason: "points_too_far", message: warnings[0] }, true);
      }
    }
  }

  const vehicle = data.vehicleId ? await getVehicle(ctx, data.vehicleId) : null;
  const truck = vehicle ? truckProfileOf(vehicle).profile : null;

  const provider = deps.provider ?? getRoutingProvider();
  const answer = await provider.buildRoutes({
    points,
    departureAt: data.departureAt,
    truck,
    avoid: data.avoidToll ? ["toll_road"] : [],
    alternatives: 1,
  });

  if (answer.ok || answer.reason !== "no_key") {
    await recordRoutingRequest(ctx, {
      provider: live ? "2gis" : "synthetic",
      ok: answer.ok,
      reason: answer.ok ? undefined : answer.reason,
    });
  }
  const fresh = await getQuota(ctx);
  if (!answer.ok) return { result: answer, quota: fresh, warnings, needsConfirmation: false };

  const settings = await getOrgSettings(ctx);
  const variants = answer.variants.map((v): ClientVariant => ({
    ...v,
    token: sealVariant({
      source: v.source,
      distanceM: v.distanceM,
      durationS: v.durationS,
      legDurationsS: v.legDurationsS,
      legsEstimated: v.legsEstimated,
      tollFiltered: data.avoidToll,
      profileComplete: answer.profileComplete,
    }),
    stops: timeline(trip, data.departureAt, v.legDurationsS, settings.windowBufferMin),
    tollFiltered: data.avoidToll,
    profileComplete: answer.profileComplete,
  }));
  return { result: { ok: true, variants }, quota: fresh, warnings, needsConfirmation: false };
}

// --- choosing an executor ----------------------------------------------------

export type ExcludedVehicle = { vehicleId: string; plate: string; reason: "capacity" | "busy"; message: string };

export type ExecutorOptionRow = ComparisonRow & {
  variantIndex: number;
  vehicleId: string | null;
  offerId: string | null;
};

type CargoTotals = { weightKg: number; pallets: number; volumeM3: number };

async function cargoTotals(ctx: Ctx, tripId: string): Promise<CargoTotals> {
  const rows = await ctx.db
    .select({
      qty: tripCargo.qtyMilli,
      lineQty: orderLines.qtyMilli,
      weight: orderLines.weightKgMilli,
      pallets: orderLines.palletsMilli,
      volume: orderLines.volumeM3Milli,
    })
    .from(tripCargo)
    .innerJoin(orderLines, eq(orderLines.id, tripCargo.orderLineId))
    .where(and(eq(tripCargo.tripId, tripId), eq(tripCargo.orgId, ctx.orgId)));

  const totals: CargoTotals = { weightKg: 0, pallets: 0, volumeM3: 0 };
  for (const r of rows) {
    const share = r.qty / r.lineQty;
    totals.weightKg += share * ((r.weight ?? 0) / 1000);
    totals.pallets += share * ((r.pallets ?? 0) / 1000);
    totals.volumeM3 += share * ((r.volume ?? 0) / 1000);
  }
  return totals;
}

function capacityProblem(v: VehicleRow, cargo: CargoTotals): string | null {
  if (v.capacityKg != null && cargo.weightKg > v.capacityKg) return "Грузоподъёмность меньше веса груза";
  if (v.capacityPallets != null && cargo.pallets > v.capacityPallets) return "Паллетовместимость меньше груза";
  if (v.capacityM3 != null && cargo.volumeM3 > v.capacityM3) return "Объём кузова меньше груза";
  return null;
}

/** Vehicles that have a current plan on another open trip overlapping the interval. */
async function busyVehicles(ctx: Ctx, tripId: string, start: Date, end: Date): Promise<Set<string>> {
  const rows = await ctx.db
    .select({
      vehicleId: planVersions.vehicleId,
      departureAt: planVersions.departureAt,
      durationS: planVersions.durationS,
      stops: planVersions.stopsSnapshot,
    })
    .from(planVersions)
    .innerJoin(trips, eq(trips.id, planVersions.tripId))
    .where(
      and(
        eq(planVersions.orgId, ctx.orgId),
        eq(planVersions.isCurrent, true),
        ne(planVersions.tripId, tripId),
        inArray(trips.status, ["planned", "assigned", "in_progress"]),
      ),
    );

  const busy = new Set<string>();
  for (const r of rows) {
    if (!r.vehicleId) continue;
    const otherStart = r.departureAt.getTime();
    const departures = r.stops.map((s) => Date.parse(s.departAt));
    const otherEnd = departures.length > 0 ? Math.max(...departures) : otherStart + r.durationS * 1000;
    if (otherStart < end.getTime() && start.getTime() < otherEnd) busy.add(r.vehicleId);
  }
  return busy;
}

const optionsInput = z.object({
  tripId: z.uuid(),
  departureAt: z.date(),
  variants: z
    .array(z.object({ token: z.string().min(1), toll: tollSchema.optional(), otherKop: z.number().int().nonnegative().optional() }))
    .min(1),
});

/**
 * Pairs every calculated variant with every own vehicle that can take the
 * cargo and every usable carrier offer, and ranks them for the planner.
 */
export async function listExecutorOptions(
  ctx: Ctx,
  input: z.input<typeof optionsInput>,
): Promise<{ rows: ExecutorOptionRow[]; excluded: ExcludedVehicle[] }> {
  requireCan(ctx, "planning.write");
  const data = parseInput(optionsInput, input);
  const trip = await getTrip(ctx, data.tripId);
  const settings = await getOrgSettings(ctx);

  const variants = data.variants.map((v, index) => {
    const sealed = openSealed(v.token);
    const plans = timeline(trip, data.departureAt, sealed.legDurationsS, settings.windowBufferMin);
    return { index, sealed, plans, toll: resolveToll(v.toll ?? { kind: "unknown" }, sealed.tollFiltered), otherKop: v.otherKop ?? 0 };
  });

  // A vehicle must be free for the longest of the variants.
  const end = new Date(Math.max(...variants.map((v) => lastDeparture(v.plans, data.departureAt).getTime())));
  const cargo = await cargoTotals(ctx, data.tripId);
  const busy = await busyVehicles(ctx, data.tripId, data.departureAt, end);

  const eligible: VehicleRow[] = [];
  const excluded: ExcludedVehicle[] = [];
  for (const v of await listVehicles(ctx, { activeOnly: true })) {
    const problem = capacityProblem(v, cargo);
    if (problem) excluded.push({ vehicleId: v.id, plate: v.plate, reason: "capacity", message: problem });
    else if (busy.has(v.id)) excluded.push({ vehicleId: v.id, plate: v.plate, reason: "busy", message: "Занята на другом рейсе в это время" });
    else eligible.push(v);
  }

  const offers = (await loadOffers(ctx, data.tripId)).filter((o) => o.status === "quoted" || o.status === "confirmed");

  const meta = new Map<string, { variantIndex: number; vehicleId: string | null; offerId: string | null }>();
  const options: Option[] = [];
  const tz = (trip.stops[1] ?? trip.stops[0]).location.tz;

  for (const v of variants) {
    const route = `маршрут ${v.index + 1}`;
    const tripDurationS = Math.round((lastDeparture(v.plans, data.departureAt).getTime() - data.departureAt.getTime()) / 1000);

    for (const vehicle of eligible) {
      const id = `${v.index}:own:${vehicle.id}`;
      options.push({
        id,
        label: `${vehicle.plate} · ${route}`,
        executor: "own",
        stops: v.plans,
        cost: estimateOwn({
          distanceM: v.sealed.distanceM,
          tripDurationS,
          fuelNormLPer100Km: vehicle.fuelNormLPer100Km,
          fuelPriceKopPerL: settings.fuelPriceKopPerL,
          driverHourKop: settings.driverHourKop,
          toll: v.toll,
          otherKop: v.otherKop,
        }),
      });
      meta.set(id, { variantIndex: v.index, vehicleId: vehicle.id, offerId: null });
    }

    for (const offer of offers) {
      const id = `${v.index}:carrier:${offer.id}`;
      const departure = departureFor(data.departureAt, v.sealed.legDurationsS, offer);
      const plans = offer.confirmedArriveAt ? timeline(trip, departure, v.sealed.legDurationsS, settings.windowBufferMin) : v.plans;
      options.push({
        id,
        label: `${offer.carrierName} · ${route}${offer.confirmedArriveAt ? "" : " (время не подтверждено)"}`,
        executor: "carrier",
        stops: plans,
        cost: estimateCarrier({
          rate: { amountKop: offer.rateKop!, vatIncluded: offer.vatIncluded, vatRateBp: offer.vatRateBp },
          expectedDowntimeKop: offer.expectedDowntimeKop,
        }),
      });
      meta.set(id, { variantIndex: v.index, vehicleId: null, offerId: offer.id });
    }
  }

  const rows = buildComparison(options, (d) => formatInTz(d, tz, "HH:mm")).map((row) => ({ ...row, ...meta.get(row.id)! }));
  return { rows, excluded };
}

// --- saving a plan -----------------------------------------------------------

const savePlanInput = z.object({
  tripId: z.uuid(),
  expectedVersion: z.number().int(),
  reason: z.string().nullable(),
  executor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("own"), vehicleId: z.uuid(), driverId: z.uuid() }),
    z.object({ kind: z.literal("carrier"), offerId: z.uuid() }),
  ]),
  departureAt: z.date(),
  route: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("sealed"), token: z.string().min(1) }),
    z.object({
      kind: z.literal("manual"),
      distanceM: z.number().int().positive("Расстояние должно быть больше нуля"),
      durationS: z.number().int().positive("Время в пути должно быть больше нуля"),
    }),
  ]),
  toll: tollSchema,
  otherKop: z.number().int().nonnegative(),
});

export type SavePlanInput = z.input<typeof savePlanInput>;

const snapshotOf = (trip: TripView, departureAt: Date, legs: number[], plans: StopPlan[]): PlanStopSnapshot[] =>
  trip.stops.map((s, i) => {
    const plan = i === 0 ? null : plans[i - 1];
    return {
      stopId: s.id,
      seq: s.seq,
      operation: s.operation,
      locationId: s.location.id,
      locationName: s.location.name,
      address: s.location.address,
      lat: s.location.lat,
      lon: s.location.lon,
      tz: s.location.tz,
      arriveAt: plan ? plan.arriveAt.toISOString() : null,
      departAt: (plan ? plan.departAt : departureAt).toISOString(),
      waitMin: plan?.waitMin ?? 0,
      windowState: plan?.windowState ?? "no_window",
      lateMin: plan?.lateMin ?? 0,
      windowStart: s.windowStart?.toISOString() ?? null,
      windowEnd: s.windowEnd?.toISOString() ?? null,
      legDurationS: i === 0 ? null : legs[i - 1],
    };
  });

/**
 * Saves a new version of the plan: route figures, executor, stop times and
 * cost as they are now. Earlier versions stay as they were. From the second
 * version a reason is required.
 */
export async function savePlan(
  ctx: Ctx,
  input: SavePlanInput,
): Promise<{ planVersionId: string; versionNo: number; tripVersion: number }> {
  const actor = requireCan(ctx, "planning.write");
  const data = parseInput(savePlanInput, input);

  return inTransaction(ctx, async (tx) => {
    const lockedTrip = await lockTrip(tx, data.tripId, data.expectedVersion, [...PLANNABLE]);
    const trip = await getTrip(tx, data.tripId);
    const settings = await getOrgSettings(tx);

    // Executor.
    let vehicle: VehicleRow | null = null;
    let offer: OfferView | null = null;
    let driverId: string | null = null;
    if (data.executor.kind === "own") {
      vehicle = await getVehicle(tx, data.executor.vehicleId);
      const driver = await getDriver(tx, data.executor.driverId);
      if (!vehicle.active) throw new DomainError("vehicle_inactive", `Машина ${vehicle.plate} выведена из работы`);
      if (!driver.active) throw new DomainError("driver_inactive", `Водитель ${driver.name} не работает`);
      driverId = driver.id;
    } else {
      const executor = data.executor;
      offer = (await loadOffers(tx, data.tripId)).find((o) => o.id === executor.offerId) ?? null;
      if (!offer) throw new DomainError("not_found", "Предложение не найдено в этом рейсе");
      if (offer.status !== "quoted" && offer.status !== "confirmed") {
        throw new DomainError("offer_not_usable", "Предложение подрядчика не получено или отклонено");
      }
    }

    // Route figures.
    const points = routePoints(trip);
    let route: SealedVariant;
    if (data.route.kind === "sealed") {
      route = openSealed(data.route.token);
    } else {
      route = {
        source: "synthetic",
        distanceM: data.route.distanceM,
        durationS: data.route.durationS,
        legDurationsS: apportion(data.route.durationS, straightLegsM(points)),
        legsEstimated: true,
        tollFiltered: false,
        profileComplete: vehicle ? isTruckProfileComplete(truckProfileOf(vehicle).profile) : true,
      };
    }
    const metricsSource = data.route.kind === "manual" ? "manual" : route.source;
    if (metricsSource === "2gis" && env.ROUTE_METRICS_STORAGE === "none") {
      throw new DomainError(
        "provider_metrics_not_storable",
        "Сохранение расстояния и времени из 2ГИС отключено настройкой. Введите значения вручную.",
      );
    }

    // Timeline and cost.
    const departureAt = departureFor(data.departureAt, route.legDurationsS, offer);
    const plans = timeline(trip, departureAt, route.legDurationsS, settings.windowBufferMin);
    const tripDurationS = Math.round((lastDeparture(plans, departureAt).getTime() - departureAt.getTime()) / 1000);
    const toll = resolveToll(data.toll, route.tollFiltered);
    const cost: CostEstimate = offer
      ? estimateCarrier({
          rate: { amountKop: offer.rateKop!, vatIncluded: offer.vatIncluded, vatRateBp: offer.vatRateBp },
          expectedDowntimeKop: offer.expectedDowntimeKop,
        })
      : estimateOwn({
          distanceM: route.distanceM,
          tripDurationS,
          fuelNormLPer100Km: vehicle!.fuelNormLPer100Km,
          fuelPriceKopPerL: settings.fuelPriceKopPerL,
          driverHourKop: settings.driverHourKop,
          toll,
          otherKop: data.otherKop,
        });

    // Version number and reason.
    const previous = await tx.db
      .select()
      .from(planVersions)
      .where(eq(planVersions.tripId, data.tripId))
      .orderBy(desc(planVersions.versionNo))
      .limit(1);
    const versionNo = (previous[0]?.versionNo ?? 0) + 1;
    const reason = data.reason?.trim() || null;
    if (versionNo > 1 && !reason) {
      throw new DomainError("reason_required", "Укажите причину изменения плана");
    }

    const current = previous.find((p) => p.isCurrent);
    if (current) await tx.db.update(planVersions).set({ isCurrent: false }).where(eq(planVersions.id, current.id));

    const [saved] = await tx.db
      .insert(planVersions)
      .values({
        orgId: tx.orgId,
        tripId: data.tripId,
        versionNo,
        isCurrent: true,
        createdBy: actor.userId,
        reason,
        executor: data.executor.kind,
        vehicleId: vehicle?.id ?? null,
        driverId,
        carrierOfferId: offer?.id ?? null,
        departureAt,
        distanceM: route.distanceM,
        durationS: route.durationS,
        metricsSource,
        tollFiltered: route.tollFiltered,
        profileComplete: route.profileComplete,
        legsEstimated: route.legsEstimated,
        stopsSnapshot: snapshotOf(trip, departureAt, route.legDurationsS, plans),
        costLines: cost.lines,
        assumptions: cost.assumptions,
        totalKop: cost.totalKop,
        incomplete: cost.incomplete,
      })
      .returning({ id: planVersions.id });

    // Status: a draft becomes planned; a changed executor sends an assigned trip back to planning.
    const executorChanged =
      !!current &&
      (current.executor !== data.executor.kind ||
        current.vehicleId !== (vehicle?.id ?? null) ||
        current.driverId !== driverId ||
        current.carrierOfferId !== (offer?.id ?? null));

    let tripVersion: number;
    if (lockedTrip.status === "draft") ({ version: tripVersion } = await moveTrip(tx, data.tripId, "planned"));
    else if (lockedTrip.status === "assigned" && executorChanged) ({ version: tripVersion } = await moveTrip(tx, data.tripId, "planned"));
    else tripVersion = await bumpVersion(tx, data.tripId);

    await audit(tx, {
      entity: "plan_version",
      entityId: saved.id,
      action: "create",
      after: { tripId: data.tripId, versionNo, executor: data.executor.kind, reason, totalKop: cost.totalKop },
    });
    return { planVersionId: saved.id, versionNo, tripVersion };
  });
}

/** Marks the trip as assigned; the first assignment fixes the baseline plan that plan-vs-fact compares with. */
export async function assignTrip(ctx: Ctx, input: { tripId: string; expectedVersion: number }): Promise<{ version: number }> {
  requireCan(ctx, "planning.write");
  return inTransaction(ctx, async (tx) => {
    const moved = await moveTrip(tx, input.tripId, "assigned", { expectedVersion: input.expectedVersion });
    const [current] = await tx.db
      .select({ id: planVersions.id })
      .from(planVersions)
      .where(and(eq(planVersions.tripId, input.tripId), eq(planVersions.isCurrent, true)));
    await tx.db
      .update(trips)
      .set({ baselinePlanVersionId: current.id })
      .where(and(eq(trips.id, input.tripId), eq(trips.orgId, tx.orgId), isNull(trips.baselinePlanVersionId)));
    return moved;
  });
}

// --- reading plans -----------------------------------------------------------

export type PlanVersionView = {
  id: string;
  versionNo: number;
  isCurrent: boolean;
  createdAt: Date;
  createdByName: string;
  reason: string | null;
  executor: "own" | "carrier";
  vehicle: { id: string; plate: string } | null;
  driver: { id: string; name: string } | null;
  offer: { id: string; carrierName: string } | null;
  departureAt: Date;
  distanceM: number;
  durationS: number;
  metricsSource: "2gis" | "synthetic" | "manual";
  tollFiltered: boolean;
  profileComplete: boolean;
  legsEstimated: boolean;
  stops: PlanStopSnapshot[];
  costLines: CostEstimate["lines"];
  assumptions: string[];
  totalKop: number;
  incomplete: boolean;
};

/** Plan versions of a trip, newest first. Costs are money data, so access follows money.read. */
export async function listPlanVersions(ctx: Ctx, tripId: string): Promise<PlanVersionView[]> {
  requireCan(ctx, "money.read");
  const [trip] = await ctx.db.select({ id: trips.id }).from(trips).where(and(eq(trips.id, tripId), eq(trips.orgId, ctx.orgId)));
  if (!trip) throw new DomainError("not_found", "Рейс не найден");

  const rows = await ctx.db
    .select({ plan: planVersions, authorName: users.name })
    .from(planVersions)
    .innerJoin(users, eq(users.id, planVersions.createdBy))
    .where(and(eq(planVersions.tripId, tripId), eq(planVersions.orgId, ctx.orgId)))
    .orderBy(desc(planVersions.versionNo));

  const vehicleIds = rows.flatMap((r) => (r.plan.vehicleId ? [r.plan.vehicleId] : []));
  const driverIds = rows.flatMap((r) => (r.plan.driverId ? [r.plan.driverId] : []));
  const offerIds = rows.flatMap((r) => (r.plan.carrierOfferId ? [r.plan.carrierOfferId] : []));

  const vehicleRows = vehicleIds.length ? await ctx.db.select({ id: vehicles.id, plate: vehicles.plate }).from(vehicles).where(inArray(vehicles.id, vehicleIds)) : [];
  const driverRows = driverIds.length ? await ctx.db.select({ id: drivers.id, name: drivers.name }).from(drivers).where(inArray(drivers.id, driverIds)) : [];
  const offerRows = offerIds.length
    ? await ctx.db
        .select({ id: carrierOffers.id, carrierName: counterparties.name })
        .from(carrierOffers)
        .innerJoin(counterparties, eq(counterparties.id, carrierOffers.carrierId))
        .where(inArray(carrierOffers.id, offerIds))
    : [];
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const vehicleById = byId(vehicleRows);
  const driverById = byId(driverRows);
  const offerById = byId(offerRows);

  return rows.map(({ plan, authorName }) => ({
    id: plan.id,
    versionNo: plan.versionNo,
    isCurrent: plan.isCurrent,
    createdAt: plan.createdAt,
    createdByName: authorName,
    reason: plan.reason,
    executor: plan.executor,
    vehicle: plan.vehicleId ? (vehicleById.get(plan.vehicleId) ?? null) : null,
    driver: plan.driverId ? (driverById.get(plan.driverId) ?? null) : null,
    offer: plan.carrierOfferId ? (offerById.get(plan.carrierOfferId) ?? null) : null,
    departureAt: plan.departureAt,
    distanceM: plan.distanceM,
    durationS: plan.durationS,
    metricsSource: plan.metricsSource,
    tollFiltered: plan.tollFiltered,
    profileComplete: plan.profileComplete,
    legsEstimated: plan.legsEstimated,
    stops: plan.stopsSnapshot,
    costLines: plan.costLines,
    assumptions: plan.assumptions,
    totalKop: plan.totalKop,
    incomplete: plan.incomplete,
  }));
}

/** True when the stops of the trip are no longer those the plan was made for. */
export function isPlanStale(plan: PlanVersionView, trip: TripView): boolean {
  return plan.stops.length !== trip.stops.length || plan.stops.some((s, i) => s.stopId !== trip.stops[i].id);
}
