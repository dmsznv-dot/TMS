import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";
import type { Ctx } from "./context";
import { verifyPassword } from "./password";

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Returns a new session token, or null when the credentials do not match. */
export async function login(
  db: Db,
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: Date } | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!user || !user.active) return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ userId: user.id, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export async function ctxFromSessionToken(db: Db, token: string): Promise<Ctx | null> {
  const [row] = await db
    .select({ userId: users.id, orgId: users.orgId, role: users.role, active: users.active })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  if (!row || !row.active) return null;
  return { db, orgId: row.orgId, actor: { kind: "user", userId: row.userId, role: row.role } };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
