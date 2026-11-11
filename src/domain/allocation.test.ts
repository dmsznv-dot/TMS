import { describe, expect, it } from "vitest";
import { checkAllocation, remainingToPlan } from "./allocation";

describe("remainingToPlan", () => {
  it("subtracts delivered and open allocations from the ordered quantity", () => {
    expect(remainingToPlan({ qty: 10_000, delivered: 3_000, allocatedOpen: 4_000 })).toBe(3_000);
  });
  it("never goes below zero", () => {
    expect(remainingToPlan({ qty: 10_000, delivered: 8_000, allocatedOpen: 4_000 })).toBe(0);
  });
});

describe("checkAllocation", () => {
  it("accepts a quantity within the remainder", () => {
    expect(checkAllocation(3_000, 3_000)).toEqual({ ok: true });
  });
  it("rejects more than the remainder", () => {
    expect(checkAllocation(3_000, 3_001)).toEqual({ ok: false, code: "exceeds_remaining" });
  });
  it("rejects zero and negative quantities", () => {
    expect(checkAllocation(3_000, 0)).toEqual({ ok: false, code: "non_positive" });
    expect(checkAllocation(3_000, -1)).toEqual({ ok: false, code: "non_positive" });
  });
});
