import { describe, expect, it } from "vitest";
import { apportion, haversineM } from "./geo";

describe("haversineM", () => {
  it("is zero for the same point", () => {
    expect(haversineM({ lat: 55, lon: 83 }, { lat: 55, lon: 83 })).toBe(0);
  });
  it("measures about 111 km per degree of latitude", () => {
    const d = haversineM({ lat: 55, lon: 83 }, { lat: 56, lon: 83 });
    expect(d).toBeGreaterThan(110_500);
    expect(d).toBeLessThan(111_800);
  });
  it("is symmetric", () => {
    const a = { lat: 55.03, lon: 82.92 };
    const b = { lat: 54.84, lon: 83.09 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
  });
});

describe("apportion", () => {
  it("splits proportionally into whole numbers that sum to the total", () => {
    expect(apportion(100, [1, 1, 1]).reduce((a, b) => a + b)).toBe(100);
    expect(apportion(100, [1, 3])).toEqual([25, 75]);
  });
  it("gives the remainder to the largest fractional parts", () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });
  it("splits evenly when every weight is zero", () => {
    expect(apportion(9, [0, 0, 0])).toEqual([3, 3, 3]);
  });
  it("returns an empty list for no weights", () => {
    expect(apportion(5, [])).toEqual([]);
  });
});
