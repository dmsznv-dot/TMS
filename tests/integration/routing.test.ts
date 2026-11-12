import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { getQuota, recordRoutingRequest } from "@/server/routing/quota";
import { makeOrg } from "../helpers/factories";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;
const ORIGINAL = { ...process.env };

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

describe("routing quota", () => {
  it("counts only successful live requests", async () => {
    const t = await withTestDb();
    try {
      const logist = await (await makeOrg(t.db)).as("logist");
      expect(await getQuota(logist)).toMatchObject({ used: 0, limit: 1000, expiresAt: null });

      await recordRoutingRequest(logist, { provider: "2gis", ok: true });
      await recordRoutingRequest(logist, { provider: "2gis", ok: true });
      await recordRoutingRequest(logist, { provider: "2gis", ok: false, reason: "timeout" });
      await recordRoutingRequest(logist, { provider: "synthetic", ok: true });

      expect((await getQuota(logist)).used).toBe(2);
    } finally {
      await t.close();
    }
  });

  it("takes the limit and the key expiry from the environment", async () => {
    process.env.TWOGIS_REQUEST_LIMIT = "50";
    process.env.TWOGIS_KEY_EXPIRES_AT = "2026-12-20";
    resetEnvCache();
    const logist = await (await makeOrg(db)).as("logist");
    const quota = await getQuota(logist);
    expect(quota.limit).toBe(50);
    expect(quota.expiresAt?.toISOString().slice(0, 10)).toBe("2026-12-20");
  });

  it("ignores an unreadable expiry date", async () => {
    process.env.TWOGIS_KEY_EXPIRES_AT = "скоро";
    resetEnvCache();
    expect((await getQuota(await (await makeOrg(db)).as("logist"))).expiresAt).toBeNull();
  });

  it("counts the whole deployment, because one key is shared by every organization", async () => {
    const t = await withTestDb();
    try {
      const a = await (await makeOrg(t.db)).as("logist");
      const b = await (await makeOrg(t.db)).as("logist");
      await recordRoutingRequest(a, { provider: "2gis", ok: true });
      await recordRoutingRequest(b, { provider: "2gis", ok: true });
      expect((await getQuota(a)).used).toBe(2);
    } finally {
      await t.close();
    }
  });
});
