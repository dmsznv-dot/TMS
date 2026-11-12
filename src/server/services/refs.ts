import { and, asc, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { isTruckProfileComplete, type TruckProfile } from "@/domain/truck";
import { requireCan, type Ctx } from "../auth/context";
import { counterparties, drivers, locations, vehicles } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { isUniqueViolation } from "./dbErrors";
import { parseInput } from "./validation";

const text = z.string().trim().min(1);
const optionalText = z.string().trim().min(1).nullish();
const positive = z.number().positive().nullish();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Время в формате ЧЧ:ММ").nullish();

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const counterpartyInput = z.object({
  name: text,
  kind: z.enum(["customer", "carrier"]),
  inn: z.string().trim().regex(/^(\d{10}|\d{12})$/, "ИНН — 10 или 12 цифр").nullish(),
  contacts: optionalText,
  bodyTypes: optionalText,
  directions: optionalText,
  vatIncluded: z.boolean().default(true),
});

const locationFields = z.object({
  name: text,
  address: optionalText,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  tz: z.string().refine(isTimeZone, "Неизвестный часовой пояс"),
  kind: z.enum(["warehouse", "dc", "customer"]),
  entryLat: z.number().min(-90).max(90).nullish(),
  entryLon: z.number().min(-180).max(180).nullish(),
  entryNotes: optionalText,
  passRules: optionalText,
  contact: optionalText,
  serviceMin: z.number().int().min(0).max(600).default(30),
  defaultWindowStart: hhmm,
  defaultWindowEnd: hhmm,
  externalKey: optionalText,
});

const entryPointIsWhole = (v: { entryLat?: number | null; entryLon?: number | null }) =>
  (v.entryLat == null) === (v.entryLon == null);
const ENTRY_MESSAGE = "Укажите обе координаты точки въезда";

export const locationInput = locationFields.refine(entryPointIsWhole, ENTRY_MESSAGE);

export const vehicleInput = z.object({
  plate: text,
  bodyType: optionalText,
  capacityKg: z.number().int().positive().nullish(),
  capacityPallets: z.number().int().positive().nullish(),
  capacityM3: positive,
  maxPermMassT: positive,
  massT: positive,
  axleLoadT: positive,
  heightM: positive,
  widthM: positive,
  lengthM: positive,
  passIds: z.array(z.number().int().nonnegative()).default([]),
  fuelNormLPer100Km: positive,
});

export const driverInput = z.object({
  name: text,
  phone: optionalText,
});

type RefTable = PgTable & { id: PgColumn; orgId: PgColumn; active: PgColumn };

/**
 * Builds the five operations shared by every reference table: create,
 * update, activate or deactivate, list and get, all bound to the caller's
 * organization. Records are never deleted, only deactivated.
 */
function refService<
  T extends RefTable,
  CreateSchema extends z.ZodType,
  PatchSchema extends z.ZodType,
>(opts: {
  table: T;
  entity: string;
  createSchema: CreateSchema;
  patchSchema: PatchSchema;
  orderBy: PgColumn;
  notFound: string;
}) {
  type Row = T["$inferSelect"];
  const { table, entity } = opts;

  const own = (ctx: Ctx, id: string) => and(eq(table.id, id), eq(table.orgId, ctx.orgId));

  async function write<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new DomainError("duplicate", "Запись с таким ключом уже существует");
      }
      throw e;
    }
  }

  async function get(ctx: Ctx, id: string): Promise<Row> {
    requireCan(ctx, "refs.read");
    const rows = (await ctx.db.select().from(table as PgTable).where(own(ctx, id))) as Row[];
    if (rows.length === 0) throw new DomainError("not_found", opts.notFound);
    return rows[0];
  }

  return {
    async create(ctx: Ctx, input: z.input<CreateSchema>): Promise<{ id: string }> {
      requireCan(ctx, "refs.write");
      const data = parseInput(opts.createSchema, input) as Record<string, unknown>;
      return write(() =>
        inTransaction(ctx, async (tx) => {
          const [row] = (await tx.db
            .insert(table as PgTable)
            .values({ ...data, orgId: tx.orgId })
            .returning()) as Row[];
          const id = (row as { id: string }).id;
          await audit(tx, { entity, entityId: id, action: "create", after: data });
          return { id };
        }),
      );
    },

    async update(ctx: Ctx, id: string, patch: z.input<PatchSchema>): Promise<void> {
      requireCan(ctx, "refs.write");
      const data = parseInput(opts.patchSchema, patch) as Record<string, unknown>;
      if (Object.keys(data).length === 0) return;
      await write(() =>
        inTransaction(ctx, async (tx) => {
          const before = await get(tx, id);
          await tx.db.update(table as PgTable).set(data).where(own(tx, id));
          await audit(tx, { entity, entityId: id, action: "update", before, after: data });
        }),
      );
    },

    async setActive(ctx: Ctx, id: string, active: boolean): Promise<void> {
      requireCan(ctx, "refs.write");
      await inTransaction(ctx, async (tx) => {
        await get(tx, id);
        await tx.db.update(table as PgTable).set({ active }).where(own(tx, id));
        await audit(tx, { entity, entityId: id, action: active ? "activate" : "deactivate" });
      });
    },

    async list(ctx: Ctx, filter: { activeOnly?: boolean; where?: SQL } = {}): Promise<Row[]> {
      requireCan(ctx, "refs.read");
      const conditions = [eq(table.orgId, ctx.orgId)];
      if (filter.activeOnly) conditions.push(eq(table.active, true));
      if (filter.where) conditions.push(filter.where);
      return (await ctx.db
        .select()
        .from(table as PgTable)
        .where(and(...conditions))
        .orderBy(asc(opts.orderBy))) as Row[];
    },

    get,
  };
}

const counterpartyService = refService({
  table: counterparties,
  entity: "counterparty",
  createSchema: counterpartyInput,
  patchSchema: counterpartyInput.partial(),
  orderBy: counterparties.name,
  notFound: "Контрагент не найден",
});

const locationService = refService({
  table: locations,
  entity: "location",
  createSchema: locationInput,
  patchSchema: locationFields.partial(),
  orderBy: locations.name,
  notFound: "Точка не найдена",
});

const vehicleService = refService({
  table: vehicles,
  entity: "vehicle",
  createSchema: vehicleInput,
  patchSchema: vehicleInput.partial(),
  orderBy: vehicles.plate,
  notFound: "Машина не найдена",
});

const driverService = refService({
  table: drivers,
  entity: "driver",
  createSchema: driverInput,
  patchSchema: driverInput.partial(),
  orderBy: drivers.name,
  notFound: "Водитель не найден",
});

export type CounterpartyRow = typeof counterparties.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
export type VehicleRow = typeof vehicles.$inferSelect;
export type DriverRow = typeof drivers.$inferSelect;

export const createCounterparty = counterpartyService.create;
export const updateCounterparty = counterpartyService.update;
export const setCounterpartyActive = counterpartyService.setActive;
export const getCounterparty = counterpartyService.get;
export function listCounterparties(
  ctx: Ctx,
  filter: { activeOnly?: boolean; kind?: "customer" | "carrier" } = {},
): Promise<CounterpartyRow[]> {
  return counterpartyService.list(ctx, {
    activeOnly: filter.activeOnly,
    where: filter.kind ? eq(counterparties.kind, filter.kind) : undefined,
  });
}

export const createLocation = locationService.create;
export const setLocationActive = locationService.setActive;
export const getLocation = locationService.get;
export const listLocations = (ctx: Ctx, filter: { activeOnly?: boolean } = {}) =>
  locationService.list(ctx, filter);

/** Updates a location; the entry point must still have both coordinates. */
export async function updateLocation(
  ctx: Ctx,
  id: string,
  patch: z.input<ReturnType<typeof locationFields.partial>>,
): Promise<void> {
  if ("entryLat" in patch || "entryLon" in patch) {
    const current = await getLocation(ctx, id);
    const merged = { entryLat: current.entryLat, entryLon: current.entryLon, ...patch };
    if (!entryPointIsWhole(merged)) throw new DomainError("validation", ENTRY_MESSAGE);
  }
  await locationService.update(ctx, id, patch);
}

export const createVehicle = vehicleService.create;
export const updateVehicle = vehicleService.update;
export const setVehicleActive = vehicleService.setActive;
export const getVehicle = vehicleService.get;
export const listVehicles = (ctx: Ctx, filter: { activeOnly?: boolean } = {}) =>
  vehicleService.list(ctx, filter);

export const createDriver = driverService.create;
export const updateDriver = driverService.update;
export const setDriverActive = driverService.setActive;
export const getDriver = driverService.get;
export const listDrivers = (ctx: Ctx, filter: { activeOnly?: boolean } = {}) =>
  driverService.list(ctx, filter);

/**
 * The part of a vehicle record a truck route needs. The profile is complete
 * when permitted mass and all three dimensions are known.
 */
export function truckProfileOf(v: VehicleRow): { profile: TruckProfile; complete: boolean } {
  const profile: TruckProfile = {};
  if (v.maxPermMassT != null) profile.maxPermMassT = v.maxPermMassT;
  if (v.massT != null) profile.massT = v.massT;
  if (v.axleLoadT != null) profile.axleLoadT = v.axleLoadT;
  if (v.heightM != null) profile.heightM = v.heightM;
  if (v.widthM != null) profile.widthM = v.widthM;
  if (v.lengthM != null) profile.lengthM = v.lengthM;
  if (v.passIds.length > 0) profile.passIds = v.passIds;
  return { profile, complete: isTruckProfileComplete(profile) };
}
