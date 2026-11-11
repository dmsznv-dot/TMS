import { randomBytes } from "node:crypto";
import type { Role } from "@/domain/permissions";
import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import { getOrder, upsertOrder } from "@/server/services/orders";
import { createLocation } from "@/server/services/refs";
import { createOrganization, createUser } from "@/server/services/users";

const unique = () => randomBytes(4).toString("hex");

export type TestOrg = {
  orgId: string;
  adminUserId: string;
  /** A context for a new user of the given role in this organization. */
  as(role: Role): Promise<Ctx>;
};

export async function makeOrg(db: Db, name = `Org ${unique()}`): Promise<TestOrg> {
  const { orgId, userId } = await createOrganization(db, {
    orgName: name,
    adminEmail: `admin-${unique()}@example.test`,
    adminPassword: "password-123",
    adminName: "Admin",
  });
  const adminCtx: Ctx = { db, orgId, actor: { kind: "user", userId, role: "admin" } };
  return {
    orgId,
    adminUserId: userId,
    async as(role) {
      if (role === "admin") return adminCtx;
      const created = await createUser(adminCtx, {
        email: `${role}-${unique()}@example.test`,
        name: role,
        role,
        password: "password-123",
      });
      return { db, orgId, actor: { kind: "user", userId: created.userId, role } };
    },
  };
}

export async function makeLocation(
  ctx: Ctx,
  name: string,
  patch: Partial<Parameters<typeof createLocation>[1]> = {},
): Promise<string> {
  const { id } = await createLocation(ctx, {
    name,
    lat: 55.05,
    lon: 82.95,
    tz: "Asia/Novosibirsk",
    kind: "customer",
    ...patch,
  });
  return id;
}

/** An order with a single line; returns the ids needed to put it on a trip. */
export async function makeOrderLine(
  ctx: Ctx,
  opts: { locationId: string; number: string; qtyMilli?: number; source?: string; windowStart?: Date; windowEnd?: Date },
): Promise<{ orderId: string; lineId: string }> {
  const { orderId } = await upsertOrder(ctx, {
    source: opts.source ?? "manual",
    number: opts.number,
    locationId: opts.locationId,
    windowStart: opts.windowStart ?? new Date("2026-11-12T02:00:00Z"),
    windowEnd: opts.windowEnd ?? new Date("2026-11-12T07:00:00Z"),
    lines: [{ lineKey: "1", product: "Вода", unit: "палл", qtyMilli: opts.qtyMilli ?? 10_000 }],
  });
  const order = await getOrder(ctx, orderId);
  return { orderId, lineId: order.lines[0].id };
}
