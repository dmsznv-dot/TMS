import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { ROLES } from "@/domain/permissions";
import { requireCan, type Ctx } from "../auth/context";
import { hashPassword } from "../auth/password";
import type { Db } from "../db/client";
import { organizations, sessions, users } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { isUniqueViolation } from "./dbErrors";
import { parseInput } from "./validation";

const email = z.string().trim().toLowerCase().pipe(z.email("Некорректный адрес почты"));
const password = z.string().min(8, "Пароль короче 8 символов");
const name = z.string().trim().min(1, "Укажите имя");

const organizationInput = z.object({
  orgName: z.string().trim().min(1, "Укажите название организации"),
  adminEmail: email,
  adminPassword: password,
  adminName: name,
});

export const userInput = z.object({
  email,
  name,
  role: z.enum(ROLES),
  password,
});

export const orgSettingsPatch = z
  .object({
    name: z.string().trim().min(1),
    vatRateBp: z.number().int().min(0).max(10_000),
    deliveryAllocBase: z.enum(["pallets", "weight"]),
    fleetRule: z.enum(["days", "km"]),
    fleetRateKop: z.number().int().min(0),
    fuelPriceKopPerL: z.number().int().min(0),
    driverHourKop: z.number().int().min(0),
    windowBufferMin: z.number().int().min(0).max(24 * 60),
  })
  .partial();

export type OrgSettings = typeof organizations.$inferSelect;


async function insertUser(
  db: Db,
  values: { orgId: string; email: string; name: string; role: (typeof ROLES)[number]; password: string },
): Promise<string> {
  try {
    const [row] = await db
      .insert(users)
      .values({
        orgId: values.orgId,
        email: values.email,
        name: values.name,
        role: values.role,
        passwordHash: await hashPassword(values.password),
      })
      .returning({ id: users.id });
    return row.id;
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new DomainError("email_taken", "Пользователь с такой почтой уже есть");
    }
    throw e;
  }
}

/** Creates an organization together with its first administrator. */
export async function createOrganization(
  db: Db,
  input: z.input<typeof organizationInput>,
): Promise<{ orgId: string; userId: string }> {
  const data = parseInput(organizationInput, input);
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: data.orgName })
      .returning({ id: organizations.id });
    const userId = await insertUser(tx, {
      orgId: org.id,
      email: data.adminEmail,
      name: data.adminName,
      role: "admin",
      password: data.adminPassword,
    });
    return { orgId: org.id, userId };
  });
}

export async function createUser(
  ctx: Ctx,
  input: z.input<typeof userInput>,
): Promise<{ userId: string }> {
  requireCan(ctx, "settings.manage");
  const data = parseInput(userInput, input);
  return inTransaction(ctx, async (tx) => {
    const userId = await insertUser(tx.db, { orgId: tx.orgId, ...data });
    await audit(tx, {
      entity: "user",
      entityId: userId,
      action: "create",
      after: { email: data.email, name: data.name, role: data.role },
    });
    return { userId };
  });
}

export async function setUserActive(
  ctx: Ctx,
  input: { userId: string; active: boolean },
): Promise<void> {
  requireCan(ctx, "settings.manage");
  await inTransaction(ctx, async (tx) => {
    const updated = await tx.db
      .update(users)
      .set({ active: input.active })
      .where(and(eq(users.id, input.userId), eq(users.orgId, tx.orgId)))
      .returning({ id: users.id });
    if (updated.length === 0) throw new DomainError("not_found", "Пользователь не найден");
    if (!input.active) {
      await tx.db.delete(sessions).where(eq(sessions.userId, input.userId));
    }
    await audit(tx, {
      entity: "user",
      entityId: input.userId,
      action: input.active ? "activate" : "deactivate",
    });
  });
}

export async function listUsers(ctx: Ctx) {
  requireCan(ctx, "settings.manage");
  return ctx.db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .where(eq(users.orgId, ctx.orgId))
    .orderBy(asc(users.name));
}

export async function getOrgSettings(ctx: Ctx): Promise<OrgSettings> {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
  if (!org) throw new DomainError("not_found", "Организация не найдена");
  return org;
}

export async function updateOrgSettings(
  ctx: Ctx,
  patch: z.input<typeof orgSettingsPatch>,
): Promise<void> {
  requireCan(ctx, "settings.manage");
  const data = parseInput(orgSettingsPatch, patch);
  if (Object.keys(data).length === 0) return;
  await inTransaction(ctx, async (tx) => {
    const before = await getOrgSettings(tx);
    await tx.db.update(organizations).set(data).where(eq(organizations.id, tx.orgId));
    await audit(tx, { entity: "organization", entityId: tx.orgId, action: "update", before, after: data });
  });
}
