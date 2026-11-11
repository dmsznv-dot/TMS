import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../env";

const TTL_MS = 2 * 60 * 60 * 1000;

/**
 * What the server keeps of a variant the user chose. The geometry stays out:
 * it is only for drawing and is never stored.
 */
export const sealedVariantSchema = z.object({
  source: z.enum(["2gis", "synthetic"]),
  distanceM: z.number().nonnegative(),
  durationS: z.number().nonnegative(),
  legDurationsS: z.array(z.number().nonnegative()),
  legsEstimated: z.boolean(),
  tollFiltered: z.boolean(),
  profileComplete: z.boolean(),
});
export type SealedVariant = z.infer<typeof sealedVariantSchema>;

const sign = (payload: string) => createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url");

/**
 * A signed, short-lived token that carries the numbers of a chosen variant
 * through the browser, so the client cannot change them before they are saved.
 */
export function sealVariant(variant: SealedVariant, now: Date = new Date()): string {
  const payload = Buffer.from(JSON.stringify({ v: variant, exp: now.getTime() + TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The variant inside a token, or null if the token is forged, malformed or expired. */
export function openVariant(token: string, now: Date = new Date()): SealedVariant | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: unknown; exp?: unknown };
    if (typeof data.exp !== "number" || data.exp < now.getTime()) return null;
    const parsed = sealedVariantSchema.safeParse(data.v);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
