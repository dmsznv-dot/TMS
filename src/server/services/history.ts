import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
import { DomainError } from "@/domain/errors";
import { describeAudit } from "@/domain/historyLabels";
import { allows, requireCan, type Ctx } from "../auth/context";
import { auditLog, trips, users } from "../db/schema";

export type HistoryEntry = {
  id: string;
  at: Date;
  actorName: string;
  /** What happened, in words. */
  line: string;
};

/** Entries about these carry amounts; roles without access to money do not see them. */
const MONEY_ENTITIES = ["expense", "accrual", "invoice", "payment"];

/**
 * Everything the audit log holds about the trip and what hangs on it
 * (plans, acceptance, expenses, invoices, documents, tasks), newest first.
 */
export async function listTripHistory(ctx: Ctx, tripId: string): Promise<HistoryEntry[]> {
  requireCan(ctx, "trips.read");
  const [trip] = await ctx.db.select({ id: trips.id }).from(trips).where(and(eq(trips.id, tripId), eq(trips.orgId, ctx.orgId)));
  if (!trip) throw new DomainError("not_found", "Рейс не найден");

  const rows = await ctx.db
    .select({ entry: auditLog, userName: users.name })
    .from(auditLog)
    .leftJoin(users, and(eq(auditLog.actorKind, "user"), eq(users.id, sql`${auditLog.actorId}::uuid`)))
    .where(
      and(
        eq(auditLog.orgId, ctx.orgId),
        or(eq(auditLog.entityId, tripId), sql`${auditLog.after}->>'tripId' = ${tripId}`),
        allows(ctx, "money.read") ? undefined : notInArray(auditLog.entity, MONEY_ENTITIES),
      ),
    )
    .orderBy(desc(auditLog.seq))
    .limit(500);

  return rows.map(({ entry, userName }) => ({
    id: entry.id,
    at: entry.at,
    actorName: entry.actorKind === "driver_link" ? "Водитель по ссылке" : entry.actorKind === "system" ? "Система" : (userName ?? "—"),
    line: describeAudit(entry),
  }));
}
