import { describe, expect, it } from "vitest";
import { estimateCarrier, estimateOwn, readOtherCost, readToll } from "./costEstimate";

const own = (patch: Partial<Parameters<typeof estimateOwn>[0]> = {}) =>
  estimateOwn({
    distanceM: 40_000,
    tripDurationS: 7200,
    fuelNormLPer100Km: 25,
    fuelPriceKopPerL: 70_00,
    driverHourKop: 600_00,
    toll: { kind: "unknown" },
    otherKop: 0,
    ...patch,
  });
const line = (e: ReturnType<typeof own>, category: string) => e.lines.find((l) => l.category === category);

describe("estimateOwn", () => {
  it("computes fuel from distance, norm and price", () => {
    expect(line(own(), "fuel")).toMatchObject({ kop: 700_00, isEstimate: true });
  });
  it("computes the driver from trip time and hourly cost", () => {
    expect(line(own(), "driver")!.kop).toBe(1200_00);
  });
  it("is incomplete while tolls are unknown", () => {
    const e = own();
    expect(line(e, "tolls")!.kop).toBeNull();
    expect(e.incomplete).toBe(true);
    expect(e.totalKop).toBe(1900_00);
  });
  it("is complete when tolls are known to be absent", () => {
    const e = own({ toll: { kind: "none" } });
    expect(e.incomplete).toBe(false);
    expect(line(e, "tolls")!.kop).toBe(0);
  });
  it("adds a known toll amount", () => {
    const e = own({ toll: { kind: "amount", kop: 350_00 } });
    expect(e.totalKop).toBe(2250_00);
    expect(line(e, "tolls")).toMatchObject({ kop: 350_00, isEstimate: false });
  });
  it("is incomplete without a fuel norm and says why", () => {
    const e = own({ fuelNormLPer100Km: null, toll: { kind: "none" } });
    expect(line(e, "fuel")!.kop).toBeNull();
    expect(e.incomplete).toBe(true);
    expect(e.assumptions.join(" ")).toContain("Норма расхода");
  });
  it("adds other costs when present", () => {
    expect(line(own({ toll: { kind: "none" }, otherKop: 100_00 }), "other")!.kop).toBe(100_00);
    expect(line(own(), "other")).toBeUndefined();
  });
  it("records the assumptions behind the figures", () => {
    const text = own().assumptions.join(" | ");
    expect(text).toContain("70,00 ₽/л");
    expect(text).toContain("600,00 ₽/ч");
  });
});

describe("estimateCarrier", () => {
  it("compares a rate with VAT on the net base", () => {
    const e = estimateCarrier({ rate: { amountKop: 50_020_00, vatIncluded: true, vatRateBp: 2200 }, expectedDowntimeKop: 0 });
    expect(e.totalKop).toBe(41_000_00);
    expect(e.incomplete).toBe(false);
  });
  it("adds expected downtime", () => {
    const e = estimateCarrier({ rate: { amountKop: 41_000_00, vatIncluded: false, vatRateBp: 2200 }, expectedDowntimeKop: 3_000_00 });
    expect(e.totalKop).toBe(44_000_00);
    expect(e.lines.map((l) => l.category)).toEqual(["carrier", "downtime"]);
  });
});

describe("reading cost inputs from a form", () => {
  it("reads a toll amount in rubles", () => {
    expect(readToll("amount", "1 500,50")).toEqual({ ok: true, toll: { kind: "amount", kop: 150_050 } });
    expect(readToll("none", "garbage")).toEqual({ ok: true, toll: { kind: "none" } });
    expect(readToll("unknown", "")).toEqual({ ok: true, toll: { kind: "unknown" } });
  });

  it("does not turn an unreadable or empty toll amount into zero rubles", () => {
    for (const bad of ["", "1 500 р.", "abc", "-5"]) {
      const result = readToll("amount", bad);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("reads other costs, where empty means none, and refuses what cannot be read", () => {
    expect(readOtherCost("")).toEqual({ ok: true, kop: 0 });
    expect(readOtherCost("  ")).toEqual({ ok: true, kop: 0 });
    expect(readOtherCost("200")).toEqual({ ok: true, kop: 20_000 });
    expect(readOtherCost("двести").ok).toBe(false);
    expect(readOtherCost("-1").ok).toBe(false);
  });
});
