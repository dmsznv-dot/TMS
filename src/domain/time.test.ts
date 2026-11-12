import { describe, expect, it } from "vitest";
import { formatInTz, zonedToUtc } from "./time";

describe("zonedToUtc", () => {
  it("converts local time in Novosibirsk to UTC", () => {
    expect(zonedToUtc("2026-11-12T14:00", "Asia/Novosibirsk").toISOString()).toBe(
      "2026-11-12T07:00:00.000Z",
    );
  });
  it("converts local time in Moscow to UTC", () => {
    expect(zonedToUtc("2026-11-12T09:30", "Europe/Moscow").toISOString()).toBe(
      "2026-11-12T06:30:00.000Z",
    );
  });
  it("throws on a malformed value", () => {
    expect(() => zonedToUtc("12.11.2026 14:00", "Asia/Novosibirsk")).toThrow();
  });
});

describe("formatInTz", () => {
  it("shows a UTC instant in the zone of the point", () => {
    expect(
      formatInTz(new Date("2026-11-12T07:00:00.000Z"), "Asia/Novosibirsk", "dd.MM.yyyy HH:mm"),
    ).toBe("12.11.2026 14:00");
  });
});
