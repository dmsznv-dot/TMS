import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { createDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { seedDemo } from "@/server/seed/demo";
import { recordEvent } from "@/server/services/execution";
import { getOrder, upsertOrder } from "@/server/services/orders";
import { assignTrip, calculateRoutes, savePlan } from "@/server/services/planning";
import { addOrderToTrip, createTrip, getTrip } from "@/server/services/trips";
import { listDrivers, listLocations, listVehicles, setVehicleActive } from "@/server/services/refs";

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

  // The same demo data a new installation gets.
  const { db, pool } = createDb(E2E_DATABASE_URL, { max: 1 });
  const { orgId } = await seedDemo(db, { password: "demo12345" });
  const [adminUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@demo.local"));
  const ctx = { db, orgId, actor: { kind: "user" as const, userId: adminUser.id, role: "admin" as const } };

  // The scenarios assume one truck, so the other demo trucks are taken out of service here.
  for (const vehicle of await listVehicles(ctx)) {
    if (vehicle.plate !== "А777АА154") await setVehicleActive(ctx, vehicle.id, false);
  }

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
  const vehicle = (await listVehicles(ctx, { activeOnly: true }))[0];
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
