import { describe, expect, it } from "vitest";
import { formatDuration, formatKm, formatWindowState } from "./format";

describe("formatKm", () => {
  it("shows kilometres with one decimal", () => {
    expect(formatKm(5904)).toBe("5,9 км");
    expect(formatKm(12_000)).toBe("12,0 км");
  });
  it("shows metres below one kilometre", () => {
    expect(formatKm(450)).toBe("450 м");
  });
});

describe("formatDuration", () => {
  it("shows hours and padded minutes", () => {
    expect(formatDuration(3900)).toBe("1 ч 05 мин");
  });
  it("shows only minutes below an hour", () => {
    expect(formatDuration(1080)).toBe("18 мин");
  });
  it("rounds seconds up to a whole minute", () => {
    expect(formatDuration(61)).toBe("2 мин");
    expect(formatDuration(1099)).toBe("19 мин");
    expect(formatDuration(0)).toBe("0 мин");
  });
  it("shows whole hours without minutes padding noise", () => {
    expect(formatDuration(7200)).toBe("2 ч 00 мин");
  });
});

describe("formatWindowState", () => {
  it("names every state", () => {
    expect(formatWindowState("on_time")).toBe("в окне");
    expect(formatWindowState("risk")).toBe("риск");
    expect(formatWindowState("late")).toBe("опоздание");
    expect(formatWindowState("no_window")).toBe("без окна");
  });
});
