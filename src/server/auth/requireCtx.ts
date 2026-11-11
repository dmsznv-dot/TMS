import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@/domain/permissions";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { env } from "../env";
import type { Ctx, UserActor } from "./context";
import { ctxFromSessionToken } from "./session";

export const SESSION_COOKIE = "tms_session";

export type UserCtx = Ctx & { actor: UserActor };

/** The context of the signed-in user, or null without a valid session. */
export async function getCtx(): Promise<UserCtx | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const ctx = await ctxFromSessionToken(getDb(), token);
  return ctx && ctx.actor.kind === "user" ? (ctx as UserCtx) : null;
}

/** The context of the signed-in user; sends the visitor to /login otherwise. */
export async function requireCtx(): Promise<UserCtx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  return ctx;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  store.delete(SESSION_COOKIE);
  return token;
}

export async function currentUser(ctx: UserCtx): Promise<{ name: string; role: Role; orgId: string }> {
  const [row] = await ctx.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, ctx.actor.userId));
  return { name: row?.name ?? "", role: ctx.actor.role, orgId: ctx.orgId };
}
