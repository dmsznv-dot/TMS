import { DomainError } from "@/domain/errors";
import { can, type Action, type Role } from "@/domain/permissions";
import type { Db } from "../db/client";

export type UserActor = { kind: "user"; userId: string; role: Role };
export type DriverLinkActor = { kind: "driver_link"; linkId: string; tripId: string };
export type Actor = UserActor | DriverLinkActor;

/**
 * Who is acting and for which organization. Built only from a session or a
 * driver link; services never take the organization from client input.
 */
export type Ctx = { db: Db; orgId: string; actor: Actor };

/** Throws "forbidden" unless the actor is a user whose role allows the action. */
export function requireCan(ctx: Ctx, action: Action): UserActor {
  if (ctx.actor.kind !== "user" || !can(ctx.actor.role, action)) {
    throw new DomainError("forbidden", "Недостаточно прав для этого действия");
  }
  return ctx.actor;
}

export function allows(ctx: Ctx, action: Action): boolean {
  return ctx.actor.kind === "user" && can(ctx.actor.role, action);
}
