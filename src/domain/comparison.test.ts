import { describe, expect, it } from "vitest";
import { buildComparison, type Option } from "./comparison";
import { computeStopPlans } from "./eta";

const t = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);
const formatTime = (d: Date) => d.toISOString().slice(11, 16);
const dc = { serviceMin: 30, windowStart: null, windowEnd: t("14:00") };
const cost = (totalKop: number) => ({ lines: [], totalKop, incomplete: false, assumptions: [] });
const option = (id: string, executor: "own" | "carrier", departure: string, totalKop: number): Option => ({
  id,
  label: id,
  executor,
  stops: computeStopPlans(t(departure), [3600], [dc], 15),
  cost: cost(totalKop),
});

describe("buildComparison: the example from the requirements", () => {
  // The distribution centre accepts until 14:00. Own truck by toll road arrives 13:35 for 35 500 ₽,
  // without toll roads 14:20 for 32 000 ₽, a carrier confirms 13:45 for 41 000 ₽.
  const rows = buildComparison(
    [
      option("Своя, платная дорога", "own", "12:35", 35_500_00),
      option("Своя, без платных", "own", "13:20", 32_000_00),
      option("Подрядчик", "carrier", "12:45", 41_000_00),
    ],
    formatTime,
  );

  it("puts the options that make the window first, cheapest first", () => {
    expect(rows.map((r) => r.id)).toEqual(["Своя, платная дорога", "Подрядчик", "Своя, без платных"]);
    expect(rows.map((r) => r.fits)).toEqual([true, true, false]);
  });

  it("explains why the cheapest option does not fit", () => {
    expect(rows[2].reason).toBe("Опоздание 20 мин к окну до 14:00");
    expect(rows[0].reason).toBeNull();
  });
});

describe("buildComparison: other cases", () => {
  it("keeps options without a window as fitting", () => {
    const o: Option = { ...option("a", "own", "12:00", 1), stops: computeStopPlans(t("12:00"), [60], [{ serviceMin: 10, windowStart: null, windowEnd: null }], 15) };
    expect(buildComparison([o], formatTime)[0].fits).toBe(true);
  });
  it("names the worst delay when several stops are late", () => {
    const stops = computeStopPlans(t("13:50"), [600, 1800], [dc, { ...dc, windowEnd: t("14:10") }], 15);
    const rows = buildComparison([{ ...option("a", "own", "12:00", 1), stops }], formatTime);
    expect(rows[0].fits).toBe(false);
    expect(rows[0].reason).toContain("мин к окну до");
  });
  it("orders equal costs by label for a stable result", () => {
    const rows = buildComparison([option("б", "own", "12:00", 5), option("а", "own", "12:00", 5)], formatTime);
    expect(rows.map((r) => r.id)).toEqual(["а", "б"]);
  });
  it("returns an empty list for no options", () => {
    expect(buildComparison([], formatTime)).toEqual([]);
  });
});
