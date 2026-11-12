import { describe, expect, it } from "vitest";
import { allocateByWeight, fleetOverheadKop, orderMarginKop, tripResult, type ExpenseLine } from "./economics";

const rub = (n: number) => n * 100;

// The reconciliation example from the requirements: revenue 112 000 ₽; direct costs planned 60 000 ₽,
// actually 71 500 ₽; fleet overhead 18 000 ₽.
const PLAN: ExpenseLine[] = [
  { category: "fuel", kop: rub(30_000) },
  { category: "driver", kop: rub(20_000) },
  { category: "tolls", kop: rub(10_000) },
];
const FACT: ExpenseLine[] = [
  { category: "fuel", kop: rub(34_500) },
  { category: "driver", kop: rub(20_000) },
  { category: "tolls", kop: rub(11_000) },
  { category: "downtime", kop: rub(6_000) },
];

describe("tripResult: the example from the requirements", () => {
  const r = tripResult({
    revenueKop: rub(112_000),
    surchargesKop: 0,
    plan: PLAN,
    fact: FACT,
    fleetPlanKop: rub(18_000),
    fleetFactKop: rub(18_000),
  });

  it("falls from 52 000 to 40 500 ₽ of marginal income", () => {
    expect(r.plan).toMatchObject({ directKop: rub(60_000), marginKop: rub(52_000) });
    expect(r.fact).toMatchObject({ directKop: rub(71_500), marginKop: rub(40_500) });
  });

  it("falls from 34 000 to 22 500 ₽ after fleet overhead", () => {
    expect(r.plan.afterFleetKop).toBe(rub(34_000));
    expect(r.fact.afterFleetKop).toBe(rub(22_500));
  });

  it("explains the difference by fuel, roads and downtime", () => {
    expect(r.deviation).toEqual([
      { category: "fuel", kop: rub(4_500) },
      { category: "tolls", kop: rub(1_000) },
      { category: "downtime", kop: rub(6_000) },
    ]);
    expect(r.deviationTotalKop).toBe(rub(11_500));
    expect(r.deviationTotalKop).toBe(r.fact.directKop - r.plan.directKop);
  });

  it("is complete when every figure is known", () => {
    expect(r.plan.incomplete).toBe(false);
    expect(r.fact.incomplete).toBe(false);
  });
});

describe("tripResult: unknown values", () => {
  const base = { revenueKop: rub(100_000), surchargesKop: 0, plan: PLAN, fact: FACT, fleetPlanKop: 0, fleetFactKop: 0 };

  it("never counts an unknown expense as zero", () => {
    const r = tripResult({ ...base, fact: [...FACT.slice(0, 2), { category: "tolls", kop: null }, FACT[3]] });
    expect(r.fact.incomplete).toBe(true);
    expect(r.fact.directKop).toBe(rub(34_500 + 20_000 + 6_000));
    expect(r.unknownCategories).toEqual(["tolls"]);
    expect(r.deviation.map((d) => d.category)).toEqual(["fuel", "downtime"]);
  });

  it("has no margin without revenue", () => {
    const r = tripResult({ ...base, revenueKop: null });
    expect(r.plan.marginKop).toBeNull();
    expect(r.fact.afterFleetKop).toBeNull();
    expect(r.fact.directKop).toBe(rub(71_500));
  });

  it("has no result after fleet overhead while the overhead is unknown", () => {
    const r = tripResult({ ...base, fleetFactKop: null });
    expect(r.fact.marginKop).toBe(rub(28_500));
    expect(r.fact.afterFleetKop).toBeNull();
    expect(r.plan.afterFleetKop).toBe(rub(40_000));
  });

  it("adds agreed surcharges to the actual revenue only", () => {
    const r = tripResult({ ...base, surchargesKop: rub(6_000) });
    expect(r.plan.marginKop).toBe(rub(40_000));
    expect(r.fact.marginKop).toBe(rub(100_000 + 6_000 - 71_500));
  });

  it("sums several lines of one category", () => {
    const r = tripResult({
      ...base,
      fact: [
        { category: "fuel", kop: rub(20_000) },
        { category: "fuel", kop: rub(14_500) },
        { category: "driver", kop: rub(20_000) },
        { category: "tolls", kop: rub(10_000) },
      ],
    });
    expect(r.deviation).toEqual([{ category: "fuel", kop: rub(4_500) }]);
    expect(r.fact.incomplete).toBe(false);
  });

  it("treats a planned category with no actual line as unknown, not as a saving", () => {
    const r = tripResult({ ...base, fact: [{ category: "fuel", kop: rub(34_500) }] });
    expect(r.deviation).toEqual([{ category: "fuel", kop: rub(4_500) }]);
    expect(r.unknownCategories).toEqual(["driver", "tolls"]);
    expect(r.fact.incomplete).toBe(true);
  });

  it("treats an explicit zero as a known actual", () => {
    const r = tripResult({ ...base, fact: [{ category: "fuel", kop: rub(30_000) }, { category: "driver", kop: rub(20_000) }, { category: "tolls", kop: 0 }] });
    expect(r.deviation).toEqual([{ category: "tolls", kop: -rub(10_000) }]);
    expect(r.unknownCategories).toEqual([]);
  });

  it("has no deviation for a category whose plan is unknown", () => {
    const r = tripResult({ ...base, plan: [PLAN[0], PLAN[1], { category: "tolls", kop: null }] });
    expect(r.plan.incomplete).toBe(true);
    expect(r.unknownCategories).toEqual(["tolls"]);
    expect(r.deviation.map((d) => d.category)).toEqual(["fuel", "downtime"]);
  });

  it("treats a category missing from the plan as planned zero", () => {
    const r = tripResult({ ...base, plan: [{ category: "fuel", kop: rub(30_000) }], fact: [{ category: "fuel", kop: rub(30_000) }, { category: "return", kop: rub(2_000) }] });
    expect(r.deviation).toEqual([{ category: "return", kop: rub(2_000) }]);
  });

  it("shows a saving as a negative deviation", () => {
    const r = tripResult({ ...base, fact: [{ category: "fuel", kop: rub(25_000) }, ...FACT.slice(1, 3)] });
    expect(r.deviation).toEqual([{ category: "fuel", kop: -rub(5_000) }, { category: "tolls", kop: rub(1_000) }]);
  });
});

describe("fleetOverheadKop", () => {
  it("charges a daily rate for the days the trip takes", () => {
    expect(fleetOverheadKop("days", rub(600), { days: 2, km: null })).toBe(rub(1_200));
  });
  it("charges a rate per kilometre", () => {
    expect(fleetOverheadKop("km", rub(15), { days: 1, km: 100.5 })).toBe(150_750);
  });
  it("is unknown without mileage", () => {
    expect(fleetOverheadKop("km", rub(15), { days: 1, km: null })).toBeNull();
  });
  it("does not need mileage for a daily rate", () => {
    expect(fleetOverheadKop("days", rub(600), { days: 1, km: null })).toBe(rub(600));
  });
});

describe("allocateByWeight", () => {
  it("splits in proportion and adds up to the total", () => {
    expect(allocateByWeight(rub(100), [{ id: "a", weight: 1 }, { id: "b", weight: 3 }])).toEqual([
      { id: "a", kop: rub(25) },
      { id: "b", kop: rub(75) },
    ]);
  });
  it("gives the rounding remainder to the largest share", () => {
    expect(allocateByWeight(10_000, [{ id: "a", weight: 1 }, { id: "b", weight: 2 }])).toEqual([
      { id: "a", kop: 3_333 },
      { id: "b", kop: 6_667 },
    ]);
  });
  it("gives the remainder to the first of equal shares", () => {
    const parts = allocateByWeight(10_000, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }])!;
    expect(parts.map((p) => p.kop)).toEqual([3_334, 3_333, 3_333]);
    expect(parts.reduce((s, p) => s + p.kop, 0)).toBe(10_000);
  });
  it("is impossible when a share has no weight", () => {
    expect(allocateByWeight(10_000, [{ id: "a", weight: 1 }, { id: "b", weight: 0 }])).toBeNull();
    expect(allocateByWeight(10_000, [])).toBeNull();
  });
  it("keeps the order of the parts", () => {
    expect(allocateByWeight(300, [{ id: "z", weight: 1 }, { id: "y", weight: 1 }, { id: "x", weight: 1 }])!.map((p) => p.id)).toEqual(["z", "y", "x"]);
  });
});

describe("orderMarginKop", () => {
  it("is selling minus cost of goods minus delivery", () => {
    expect(orderMarginKop([{ qty: 10_000, priceKop: rub(520), costKop: rub(410) }], rub(300))).toBe(rub(800));
  });
  it("adds up lines", () => {
    expect(
      orderMarginKop(
        [
          { qty: 10_000, priceKop: rub(520), costKop: rub(410) },
          { qty: 4_000, priceKop: rub(780), costKop: rub(600) },
        ],
        0,
      ),
    ).toBe(rub(1_100 + 720));
  });
  it("is unknown when a price or a cost is missing", () => {
    expect(orderMarginKop([{ qty: 1_000, priceKop: null, costKop: 100 }], 0)).toBeNull();
    expect(orderMarginKop([{ qty: 1_000, priceKop: 100, costKop: null }], 0)).toBeNull();
    expect(orderMarginKop([], 0)).toBeNull();
  });
});
