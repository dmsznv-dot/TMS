import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../env";
import { getRoutingProvider } from "./index";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

const request = {
  points: [
    { lat: 55.03, lon: 82.92 },
    { lat: 55.06, lon: 82.95 },
  ],
  departureAt: new Date(),
  truck: null,
  avoid: [],
  alternatives: 1,
};

describe("getRoutingProvider", () => {
  it("uses the synthetic provider by default", async () => {
    delete process.env.ROUTING_MODE;
    resetEnvCache();
    const result = await getRoutingProvider().buildRoutes(request);
    expect(result.ok && result.variants[0].source).toBe("synthetic");
  });

  it("answers no_key in live mode without a key", async () => {
    process.env.ROUTING_MODE = "live";
    delete process.env.TWOGIS_API_KEY;
    resetEnvCache();
    expect(await getRoutingProvider().buildRoutes(request)).toMatchObject({ ok: false, reason: "no_key" });
  });
});
