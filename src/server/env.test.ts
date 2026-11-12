import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  it("treats variables that are set to an empty string as not set (docker compose passes them like that)", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      SESSION_SECRET: "x".repeat(32),
      ROUTING_MODE: "synthetic",
      TWOGIS_API_KEY: "",
      TWOGIS_KEY_EXPIRES_AT: "",
      TWOGIS_REQUEST_LIMIT: "",
      ROUTE_METRICS_STORAGE: "",
      EXPORT_PROVIDER_METRICS: "",
      SESSION_COOKIE_SECURE: "",
      MAP_TILE_URL: "",
      SEED_PASSWORD: "",
    } as NodeJS.ProcessEnv);
    expect(env.TWOGIS_API_KEY).toBeUndefined();
    expect(env.TWOGIS_REQUEST_LIMIT).toBe(1000);
    expect(env.ROUTE_METRICS_STORAGE).toBe("plan");
    expect(env.EXPORT_PROVIDER_METRICS).toBe(false);
    expect(env.SEED_PASSWORD).toBe("demo12345");
  });
});
