import { and, eq, sql } from "drizzle-orm";
import { requireCan, type Ctx } from "../auth/context";
import { routingRequestLog } from "../db/schema";
import { env } from "../env";
import type { RouteFailure } from "./types";

export type Quota = {
  /** Successful 2GIS requests so far. */
  used: number;
  limit: number;
  /** When the key stops working, if known. */
  expiresAt: Date | null;
  /** False in the built-in demo mode, where no 2GIS request is made. */
  live: boolean;
};

export async function recordRoutingRequest(
  ctx: Ctx,
  entry: { provider: "2gis" | "synthetic"; ok: boolean; reason?: RouteFailure },
): Promise<void> {
  await ctx.db.insert(routingRequestLog).values({
    orgId: ctx.orgId,
    userId: ctx.actor.kind === "user" ? ctx.actor.userId : null,
    provider: entry.provider,
    ok: entry.ok,
    reason: entry.reason ?? null,
  });
}

/**
 * The key is shared by the whole installation, so usage is counted across
 * every organization: the limit is spent by all of them.
 */
export async function getQuota(ctx: Ctx): Promise<Quota> {
  requireCan(ctx, "trips.read");
  const [{ used }] = await ctx.db
    .select({ used: sql<number>`count(*)::int` })
    .from(routingRequestLog)
    .where(and(eq(routingRequestLog.provider, "2gis"), eq(routingRequestLog.ok, true)));

  const expires = env.TWOGIS_KEY_EXPIRES_AT ? new Date(env.TWOGIS_KEY_EXPIRES_AT) : null;
  return {
    used,
    limit: env.TWOGIS_REQUEST_LIMIT,
    expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
    live: env.ROUTING_MODE === "live",
  };
}
