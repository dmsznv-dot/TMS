import { describe, expect, it } from "vitest";
import { deriveOrderStatus } from "./orderStatus";

const line = (qty: number, allocatedOpen: number, delivered: number) => ({ qty, allocatedOpen, delivered });

describe("deriveOrderStatus", () => {
  it("is new when nothing is planned or delivered", () => {
    expect(deriveOrderStatus([line(10_000, 0, 0)], false)).toBe("new");
  });
  it("is partially planned when part of a line is on an open trip", () => {
    expect(deriveOrderStatus([line(10_000, 4_000, 0)], false)).toBe("partially_planned");
  });
  it("is planned when every line is fully on open trips", () => {
    expect(deriveOrderStatus([line(10_000, 10_000, 0)], false)).toBe("planned");
  });
  it("is partially delivered when some quantity is accepted and nothing is in transit", () => {
    expect(deriveOrderStatus([line(10_000, 0, 6_000)], false)).toBe("partially_delivered");
  });
  it("is delivered when every line is fully accepted", () => {
    expect(deriveOrderStatus([line(10_000, 0, 10_000)], false)).toBe("delivered");
  });
  it("is cancelled regardless of progress", () => {
    expect(deriveOrderStatus([line(10_000, 0, 0)], true)).toBe("cancelled");
  });
  it("is planned when the rest of a partly delivered order is on an open trip", () => {
    expect(deriveOrderStatus([line(10_000, 4_000, 6_000)], false)).toBe("planned");
  });
  it("is partially planned when one of two lines is untouched", () => {
    expect(deriveOrderStatus([line(5_000, 5_000, 0), line(5_000, 0, 0)], false)).toBe("partially_planned");
  });
  it("is new for an order without lines", () => {
    expect(deriveOrderStatus([], false)).toBe("new");
  });
});
