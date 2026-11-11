import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { requireCan, type Ctx } from "../auth/context";
import { hashToken } from "../auth/session";
import type { Db } from "../db/client";
import { shareLinks, trips } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { parseInput } from "./validation";

const DAY_MS = 24 * 60 * 60 * 1000;

const linkInput = z.object({
  tripId: z.uuid(),
  ttlDays: z.number().int().min(1, "Срок — от 1 до 30 дней").max(30, "Срок — от 1 до 30 дней").default(3),
});

/** Creates a link for the driver or carrier. The token is returned once and only its hash is kept. */
export async function createShareLink(
  ctx: Ctx,
  input: z.input<typeof linkInput>,
): Promise<{ token: string; expiresAt: Date }> {
  const actor = requireCan(ctx, "planning.write");
  const data = parseInput(linkInput, input);

  return inTransaction(ctx, async (tx) => {
    const [trip] = await tx.db
      .select({ status: trips.status })
      .from(trips)
      .where(and(eq(trips.id, data.tripId), eq(trips.orgId, tx.orgId)));
    if (!trip) throw new DomainError("not_found", "Рейс не найден");
    if (!["planned", "assigned", "in_progress"].includes(trip.status)) {
      throw new DomainError("trip_not_active", "Ссылку можно создать для запланированного или назначенного рейса");
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + data.ttlDays * DAY_MS);
    const [row] = await tx.db
      .insert(shareLinks)
      .values({ orgId: tx.orgId, tripId: data.tripId, tokenHash: hashToken(token), expiresAt, createdBy: actor.userId })
      .returning({ id: shareLinks.id });
    await audit(tx, { entity: "share_link", entityId: row.id, action: "create", after: { tripId: data.tripId, expiresAt } });
    return { token, expiresAt };
  });
}

export async function listShareLinks(ctx: Ctx, tripId: string) {
  requireCan(ctx, "planning.write");
  const rows = await ctx.db
    .select({ id: shareLinks.id, createdAt: shareLinks.createdAt, expiresAt: shareLinks.expiresAt, revokedAt: shareLinks.revokedAt })
    .from(shareLinks)
    .where(and(eq(shareLinks.tripId, tripId), eq(shareLinks.orgId, ctx.orgId)))
    .orderBy(desc(shareLinks.createdAt));
  const now = Date.now();
  return rows.map((r) => ({ ...r, expired: r.expiresAt.getTime() < now }));
}

export async function revokeShareLink(ctx: Ctx, linkId: string): Promise<void> {
  requireCan(ctx, "planning.write");
  await inTransaction(ctx, async (tx) => {
    const updated = await tx.db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(shareLinks.id, linkId), eq(shareLinks.orgId, tx.orgId), isNull(shareLinks.revokedAt)))
      .returning({ id: shareLinks.id });
    if (updated.length === 0) throw new DomainError("not_found", "Ссылка не найдена или уже отозвана");
    await audit(tx, { entity: "share_link", entityId: linkId, action: "revoke" });
  });
}

/**
 * The context for a token, limited to the one trip the link was made for.
 * Unknown, expired and revoked tokens, and links of cancelled trips, give null.
 */
export async function ctxFromShareToken(db: Db, token: string): Promise<Ctx | null> {
  if (!token) return null;
  const [row] = await db
    .select({ linkId: shareLinks.id, orgId: shareLinks.orgId, tripId: shareLinks.tripId, tripStatus: trips.status })
    .from(shareLinks)
    .innerJoin(trips, eq(trips.id, shareLinks.tripId))
    .where(and(eq(shareLinks.tokenHash, hashToken(token)), isNull(shareLinks.revokedAt), gt(shareLinks.expiresAt, new Date())));
  if (!row || row.tripStatus === "cancelled") return null;
  return { db, orgId: row.orgId, actor: { kind: "driver_link", linkId: row.linkId, tripId: row.tripId } };
}
