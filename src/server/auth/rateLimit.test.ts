import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "./rateLimit";

beforeEach(resetRateLimits);

describe("rateLimit", () => {
  it("allows the limit and blocks the next request within the minute", () => {
    const now = 1_000_000;
    for (let i = 0; i < 60; i++) expect(rateLimit("link-a", 60, now)).toBe(true);
    expect(rateLimit("link-a", 60, now)).toBe(false);
  });
  it("starts a new window after a minute", () => {
    for (let i = 0; i < 3; i++) rateLimit("k", 3, 0);
    expect(rateLimit("k", 3, 59_000)).toBe(false);
    expect(rateLimit("k", 3, 60_001)).toBe(true);
  });
  it("counts keys separately", () => {
    for (let i = 0; i < 3; i++) rateLimit("a", 3, 0);
    expect(rateLimit("a", 3, 0)).toBe(false);
    expect(rateLimit("b", 3, 0)).toBe(true);
  });
});
