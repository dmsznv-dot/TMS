import { describe, expect, it } from "vitest";
import { formatQty, parseQty } from "./qty";

describe("parseQty", () => {
  it("parses a decimal comma", () => {
    expect(parseQty("1,5")).toBe(1500);
  });
  it("parses a number", () => {
    expect(parseQty(2)).toBe(2000);
  });
  it("parses grouped thousands", () => {
    expect(parseQty("1 234,5")).toBe(1_234_500);
  });
  it("rejects negative values", () => {
    expect(parseQty("-1")).toBeNull();
  });
  it("rejects more than three decimal places", () => {
    expect(parseQty("0,0001")).toBeNull();
  });
  it("rejects text and empty input", () => {
    expect(parseQty("много")).toBeNull();
    expect(parseQty("")).toBeNull();
  });
});

describe("formatQty", () => {
  it("drops trailing zeros", () => {
    expect(formatQty(1500)).toBe("1,5");
    expect(formatQty(2000)).toBe("2");
  });
  it("keeps three decimals when needed", () => {
    expect(formatQty(1)).toBe("0,001");
  });
});
