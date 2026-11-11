import { describe, expect, it } from "vitest";
import { formatRub, grossKop, netKop, parseRub } from "./money";

describe("netKop", () => {
  it("removes VAT from a VAT-inclusive amount", () => {
    expect(netKop({ amountKop: 122_00, vatIncluded: true, vatRateBp: 2200 })).toBe(100_00);
  });
  it("keeps an amount that is already net", () => {
    expect(netKop({ amountKop: 100_00, vatIncluded: false, vatRateBp: 2200 })).toBe(100_00);
  });
  it("rounds half up to a whole kopeck", () => {
    expect(netKop({ amountKop: 1, vatIncluded: true, vatRateBp: 2200 })).toBe(1);
  });
  it("normalizes a carrier rate with VAT to the net base", () => {
    expect(netKop({ amountKop: 50_020_00, vatIncluded: true, vatRateBp: 2200 })).toBe(41_000_00);
  });
});

describe("grossKop", () => {
  it("adds VAT to a net amount", () => {
    expect(grossKop({ amountKop: 100_00, vatIncluded: false, vatRateBp: 2200 })).toBe(122_00);
  });
  it("keeps an amount that already includes VAT", () => {
    expect(grossKop({ amountKop: 122_00, vatIncluded: true, vatRateBp: 2200 })).toBe(122_00);
  });
});

describe("parseRub", () => {
  it("accepts spaces and a decimal comma", () => {
    expect(parseRub("1 234,56")).toBe(123_456);
  });
  it("accepts non-breaking spaces and a decimal point", () => {
    expect(parseRub("1 234.5")).toBe(123_450);
  });
  it("accepts a whole number of rubles", () => {
    expect(parseRub("41000")).toBe(4_100_000);
  });
  it("rejects text", () => {
    expect(parseRub("abc")).toBeNull();
  });
  it("rejects an empty string", () => {
    expect(parseRub("  ")).toBeNull();
  });
  it("rejects more than two decimal places", () => {
    expect(parseRub("1,234")).toBeNull();
  });
});

describe("formatRub", () => {
  it("groups thousands and shows kopecks", () => {
    expect(formatRub(3_550_000)).toBe("35 500,00 ₽");
  });
  it("formats negative amounts", () => {
    expect(formatRub(-1_150_000)).toBe("−11 500,00 ₽");
  });
});
