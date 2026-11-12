import { describe, expect, it } from "vitest";
import { haversineM } from "@/domain/geo";
import { createSyntheticProvider } from "./synthetic";
import type { RouteRequest, RouteResult } from "./types";

const A = { lat: 55.0302, lon: 82.9204 };
const B = { lat: 55.0585, lon: 83.0252 };
const C = { lat: 55.0415, lon: 82.9146 };

const request = (patch: Partial<RouteRequest> = {}): RouteRequest => ({
  points: [A, B, C],
  departureAt: new Date("2026-11-12T03:00:00Z"),
  truck: null,
  avoid: [],
  alternatives: 1,
  ...patch,
});

function variants(result: RouteResult) {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
  return result.variants;
}

describe("synthetic provider", () => {
  const provider = createSyntheticProvider();

  it("returns a main variant and one alternative marked as synthetic", async () => {
    const found = variants(await provider.buildRoutes(request()));
    expect(found).toHaveLength(2);
    expect(found.every((v) => v.source === "synthetic")).toBe(true);
    expect(found[1].distanceM).toBeGreaterThan(found[0].distanceM);
    expect(found[1].durationS).toBeLessThan(found[0].durationS);
  });

  it("returns only the main variant when no alternatives are requested", async () => {
    expect(variants(await provider.buildRoutes(request({ alternatives: 0 })))).toHaveLength(1);
  });

  it("measures distance along the legs with a detour factor", async () => {
    const [main] = variants(await provider.buildRoutes(request()));
    const straight = haversineM(A, B) + haversineM(B, C);
    expect(main.distanceM).toBeGreaterThan(straight);
    expect(main.distanceM).toBeLessThan(straight * 1.31);
  });

  it("gives one duration per leg and they add up", async () => {
    for (const v of variants(await provider.buildRoutes(request()))) {
      expect(v.legDurationsS).toHaveLength(2);
      expect(v.legDurationsS.reduce((a, b) => a + b, 0)).toBe(v.durationS);
      expect(v.legsEstimated).toBe(false);
    }
  });

  it("draws every variant as polylines of [lat, lon]", async () => {
    const [main] = variants(await provider.buildRoutes(request()));
    expect(main.geometry.length).toBeGreaterThan(0);
    expect(main.geometry[0][0]).toEqual([A.lat, A.lon]);
  });

  it("reports the profile as complete only when it is", async () => {
    const without = await provider.buildRoutes(request({ truck: null }));
    const full = await provider.buildRoutes(request({ truck: { maxPermMassT: 12, heightM: 3, widthM: 2.5, lengthM: 8 } }));
    expect(without.ok && without.profileComplete).toBe(false);
    expect(full.ok && full.profileComplete).toBe(true);
  });

  it("is deterministic", async () => {
    expect(await provider.buildRoutes(request())).toEqual(await provider.buildRoutes(request()));
  });

  it.each([
    ["a single point", [A]],
    ["eleven points", Array.from({ length: 11 }, () => A)],
    ["a latitude out of range", [A, { lat: 95, lon: 83 }]],
    ["a coordinate that is not a number", [A, { lat: Number.NaN, lon: 83 }]],
  ])("rejects %s", async (_name, points) => {
    const result = await provider.buildRoutes(request({ points }));
    expect(result).toMatchObject({ ok: false, reason: "bad_request" });
  });
});
