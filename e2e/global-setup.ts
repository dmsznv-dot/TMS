import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "@/server/db/client";
import { recordEvent } from "@/server/services/execution";
import { getOrder, upsertOrder } from "@/server/services/orders";
import { assignTrip, calculateRoutes, savePlan } from "@/server/services/planning";
import { addOrderToTrip, createTrip, getTrip } from "@/server/services/trips";
import { createCounterparty, createDriver, createLocation, createVehicle, listDrivers, listLocations, listVehicles } from "@/server/services/refs";
import { createOrganization, createUser } from "@/server/services/users";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://tms:tms@localhost:5432/tms_e2e";

/** Recreates the end-to-end database from migrations and adds demo users. */
export default async function globalSetup(): Promise<void> {
  const admin = new Pool({ connectionString: E2E_DATABASE_URL, max: 1 });
  await admin.query("drop schema if exists public cascade");
  await admin.query("drop schema if exists drizzle cascade");
  await admin.query("create schema public");
  if (existsSync("drizzle/meta/_journal.json")) {
    await migrate(drizzle(admin), { migrationsFolder: "drizzle" });
  }
  await admin.end();

  // Temporary users; replaced by the demo seed once it exists.
  const { db, pool } = createDb(E2E_DATABASE_URL, { max: 1 });
  const { orgId, userId } = await createOrganization(db, {
    orgName: "Демо-поставщик",
    adminEmail: "admin@demo.local",
    adminPassword: "demo12345",
    adminName: "Администратор",
  });
  const ctx = { db, orgId, actor: { kind: "user" as const, userId, role: "admin" as const } };
  for (const [role, name] of [
    ["logist", "Логист"],
    ["warehouse", "Склад"],
    ["finance", "Финансы"],
    ["manager", "Руководитель"],
  ] as const) {
    await createUser(ctx, { email: `${role}@demo.local`, name, role, password: "demo12345" });
  }
  // Temporary reference data; replaced by the demo seed once it exists.
  const tz = "Asia/Novosibirsk";
  const points = [
    { name: "Склад на Станционной", externalKey: "WH-1", kind: "warehouse", lat: 54.9925, lon: 82.8285 },
    { name: "РЦ «Продукты у дома»", externalKey: "RC-1", kind: "dc", lat: 55.0585, lon: 83.0252, entryLat: 55.0597, entryLon: 83.0231, entryNotes: "Въезд с северной стороны, ворота 4", defaultWindowStart: "08:00", defaultWindowEnd: "14:00" },
    { name: "Магазин на Красном проспекте", externalKey: "SHOP-1", kind: "customer", lat: 55.0415, lon: 82.9146 },
    { name: "Магазин в Академгородке", externalKey: "SHOP-2", kind: "customer", lat: 54.8441, lon: 83.0921 },
    { name: "Магазин на Затулинке", externalKey: "SHOP-3", kind: "customer", lat: 54.9472, lon: 82.9033 },
  ] as const;
  for (const point of points) await createLocation(ctx, { ...point, tz });

  await createVehicle(ctx, {
    plate: "А777АА154",
    bodyType: "Тент",
    capacityPallets: 20,
    fuelNormLPer100Km: 25,
    maxPermMassT: 12,
    massT: 9,
    axleLoadT: 6,
    heightM: 3.4,
    widthM: 2.5,
    lengthM: 8.2,
  });
  await createDriver(ctx, { name: "Пётр Петров", phone: "+7 900 111-22-33" });
  await createCounterparty(ctx, { name: "ООО Ромашка", kind: "customer" });
  await createCounterparty(ctx, { name: "ИП Перевозов", kind: "carrier" });

  const byKey = new Map((await listLocations(ctx)).map((l) => [l.externalKey, l.id]));
  const window = { windowStart: new Date("2026-11-12T02:00:00Z"), windowEnd: new Date("2026-11-12T08:00:00Z") };
  for (const [number, key, qtyMilli] of [
    ["П-2001", "SHOP-1", 10_000],
    ["П-2002", "SHOP-3", 5_000],
  ] as const) {
    await upsertOrder(ctx, {
      source: "e2e",
      number,
      locationId: byKey.get(key)!,
      customerName: "ООО Ромашка",
      ...window,
      lines: [{ lineKey: "1", product: "Вода 0,5 л", unit: "палл", qtyMilli, palletsMilli: qtyMilli }],
    });
  }

  // Trips prepared in advance, each on its own day so the one truck never conflicts:
  // Р-0001 is assigned (the execution scenario takes it from there), Р-0002 is already completed
  // (the money scenario works on it).
  await seedTrip(ctx, byKey, { orders: ["П-4001", "П-4002"], keys: ["SHOP-2", "SHOP-3"], day: "2026-11-14", completed: false });
  await seedTrip(ctx, byKey, { orders: ["П-5001", "П-5002"], keys: ["SHOP-1", "SHOP-3"], day: "2026-11-16", completed: true });
  await pool.end();
}

type SeedCtx = Parameters<typeof createTrip>[0];

/** An assigned trip with two orders; when `completed`, the truck has also done every stop. */
async function seedTrip(
  ctx: SeedCtx,
  byKey: Map<string | null, string>,
  opts: { orders: [string, string]; keys: [string, string]; day: string; completed: boolean },
): Promise<void> {
  const windows = { windowStart: new Date(`${opts.day}T02:00:00Z`), windowEnd: new Date(`${opts.day}T08:00:00Z`) };
  const lineIds: string[] = [];
  for (const [i, number] of opts.orders.entries()) {
    const { orderId } = await upsertOrder(ctx, {
      source: "e2e",
      number,
      locationId: byKey.get(opts.keys[i])!,
      customerName: "ООО Колос",
      ...windows,
      lines: [{ lineKey: "1", product: "Сок 1 л", unit: "палл", qtyMilli: 5_000, palletsMilli: 5_000 }],
    });
    lineIds.push((await getOrder(ctx, orderId)).lines[0].id);
  }

  const { tripId } = await createTrip(ctx, { originLocationId: byKey.get("WH-1")! });
  const { version } = await addOrderToTrip(ctx, {
    tripId,
    expectedVersion: 1,
    items: lineIds.map((orderLineId) => ({ orderLineId, qtyMilli: 5_000 })),
  });
  const departureAt = new Date(`${opts.day}T03:00:00Z`);
  const vehicle = (await listVehicles(ctx))[0];
  const driver = (await listDrivers(ctx))[0];
  const calc = await calculateRoutes(ctx, { tripId, departureAt, vehicleId: vehicle.id, avoidToll: true });
  if (!calc.result.ok) throw new Error(`e2e setup: ${calc.result.reason}`);
  const saved = await savePlan(ctx, {
    tripId,
    expectedVersion: version,
    reason: null,
    executor: { kind: "own", vehicleId: vehicle.id, driverId: driver.id },
    departureAt,
    route: { kind: "sealed", token: calc.result.variants[0].token },
    toll: { kind: "none" },
    otherKop: 0,
  });
  await assignTrip(ctx, { tripId, expectedVersion: saved.tripVersion });

  if (opts.completed) {
    for (const stop of (await getTrip(ctx, tripId)).stops) {
      await recordEvent(ctx, { tripId, type: stop.operation === "load" ? "loaded" : "unloaded", stopId: stop.id });
    }
  }
}
