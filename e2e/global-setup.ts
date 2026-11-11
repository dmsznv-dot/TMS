import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "@/server/db/client";
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
  await pool.end();
}
