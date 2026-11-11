import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "@/server/db/client";
import { createLocation } from "@/server/services/refs";
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
  await pool.end();
}
