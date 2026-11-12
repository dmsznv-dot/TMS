import { describe, expect, it } from "vitest";
import { openVariant, sealVariant, type SealedVariant } from "./variantToken";

const variant: SealedVariant = {
  source: "2gis",
  distanceM: 5904,
  durationS: 1099,
  legDurationsS: [1099],
  legsEstimated: true,
  tollFiltered: false,
  profileComplete: true, binding: "trip|stops"
};
const NOW = new Date("2026-11-12T03:00:00Z");

describe("variant token", () => {
  it("round-trips a variant", () => {
    expect(openVariant(sealVariant(variant, NOW), NOW)).toEqual(variant);
  });

  it("expires after two hours", () => {
    const token = sealVariant(variant, NOW);
    expect(openVariant(token, new Date(NOW.getTime() + 119 * 60_000))).toEqual(variant);
    expect(openVariant(token, new Date(NOW.getTime() + 121 * 60_000))).toBeNull();
  });

  it("rejects a changed payload", () => {
    const [, signature] = sealVariant(variant, NOW).split(".");
    const forged = Buffer.from(JSON.stringify({ v: { ...variant, distanceM: 1 }, exp: NOW.getTime() + 3600_000 })).toString("base64url");
    expect(openVariant(`${forged}.${signature}`, NOW)).toBeNull();
  });

  it("rejects a changed signature and malformed tokens", () => {
    const [payload] = sealVariant(variant, NOW).split(".");
    expect(openVariant(`${payload}.AAAA`, NOW)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", ".", "!!!.???"]) expect(openVariant(bad, NOW)).toBeNull();
  });

  it("rejects a validly signed payload of the wrong shape", async () => {
    const { createHmac } = await import("node:crypto");
    const { env } = await import("../env");
    const payload = Buffer.from(JSON.stringify({ v: { source: "2gis" }, exp: NOW.getTime() + 3600_000 })).toString("base64url");
    const signature = createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url");
    expect(openVariant(`${payload}.${signature}`, NOW)).toBeNull();
  });
});
