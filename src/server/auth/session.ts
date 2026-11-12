import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";
import type { Ctx } from "./context";
import { DomainError } from "@/domain/errors";
import { hashPassword, verifyPassword } from "./password";
import { isRateLimited, rateLimit } from "./rateLimit";

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const FAILED_LOGINS_PER_MINUTE = 10;
/** Checked against when the address is unknown, so an unknown address costs as much time as a wrong password. */
let decoyHash: Promise<string> | null = null;

/** Returns a new session token, or null when the credentials do not match. Throws `rate_limited` after too many failed attempts. */
export async function login(
  db: Db,
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: Date } | null> {
  const address = email.trim().toLowerCase();
  const key = `login:${address}`;
  if (isRateLimited(key, FAILED_LOGINS_PER_MINUTE)) {
    throw new DomainError("rate_limited", "Слишком много неудачных попыток входа. Подождите минуту и повторите.");
  }
  // Only failures are counted, so a person who signs in correctly is never held back.
  const fail = () => {
    rateLimit(key, FAILED_LOGINS_PER_MINUTE);
    return null;
  };
  const [user] = await db.select().from(users).where(eq(users.email, address));
  if (!user || !user.active) {
    decoyHash ??= hashPassword("decoy-password-never-valid");
    await verifyPassword(password, await decoyHash);
    return fail();
  }
  if (!(await verifyPassword(password, user.passwordHash))) return fail();

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
