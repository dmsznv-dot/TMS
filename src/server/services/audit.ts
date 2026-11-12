import type { Ctx } from "../auth/context";
import { auditLog } from "../db/schema";

export type AuditEntry = {
  entity: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
};

/** Appends a record of a change. Call it inside the same transaction as the change. */
export async function audit(ctx: Ctx, entry: AuditEntry): Promise<void> {
  await ctx.db.insert(auditLog).values({
    orgId: ctx.orgId,
    actorKind: ctx.actor.kind,
    actorId: ctx.actor.kind === "user" ? ctx.actor.userId : ctx.actor.linkId,
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

/** Runs the callback in a transaction with a context bound to it. */
export function inTransaction<T>(ctx: Ctx, fn: (tx: Ctx) => Promise<T>): Promise<T> {
  return ctx.db.transaction((tx) => fn({ ...ctx, db: tx }));
}
