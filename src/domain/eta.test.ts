import { describe, expect, it } from "vitest";
import { computeStopPlans } from "./eta";

const t = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00Z`);
const stop = { serviceMin: 30, windowStart: t("09:00"), windowEnd: t("14:00") };

describe("computeStopPlans: window state", () => {
  it("is on time with a margin before the end of the window", () => {
    const [plan] = computeStopPlans(t("12:35"), [3600], [stop], 15);
    expect(plan.arriveAt).toEqual(t("13:35"));
    expect(plan.windowState).toBe("on_time");
  });
  it("is at risk within the buffer", () => {
    expect(computeStopPlans(t("12:50"), [3600], [stop], 15)[0].windowState).toBe("risk");
  });
  it("is on time exactly at the edge of the buffer", () => {
    expect(computeStopPlans(t("12:45"), [3600], [stop], 15)[0].windowState).toBe("on_time");
  });
  it("is late after the window closes and says by how much", () => {
    expect(computeStopPlans(t("13:20"), [3600], [stop], 15)[0]).toMatchObject({ windowState: "late", lateMin: 20 });
  });
  it("is at risk, not late, when arriving exactly at the end of the window", () => {
    expect(computeStopPlans(t("13:00"), [3600], [stop], 15)[0]).toMatchObject({ windowState: "risk", lateMin: 0 });
  });
  it("has no verdict for a stop without a window", () => {
    const [plan] = computeStopPlans(t("12:00"), [600], [{ serviceMin: 20, windowStart: null, windowEnd: null }], 15);
    expect(plan).toMatchObject({ windowState: "no_window", lateMin: 0, waitMin: 0 });
  });
  it("reports the end of the window for the explanation", () => {
    expect(computeStopPlans(t("12:00"), [600], [stop], 15)[0].windowEnd).toEqual(t("14:00"));
  });
});

describe("computeStopPlans: waiting and chaining", () => {
  it("waits for the window to open and shifts what follows", () => {
    const plans = computeStopPlans(t("07:00"), [3600, 1800], [stop, stop], 15);
    expect(plans[0]).toMatchObject({ arriveAt: t("08:00"), waitMin: 60, departAt: t("09:30") });
    expect(plans[1].arriveAt).toEqual(t("10:00"));
    expect(plans[1].departAt).toEqual(t("10:30"));
  });
  it("adds service time of earlier stops", () => {
    const plans = computeStopPlans(t("10:00"), [900, 900], [{ ...stop, serviceMin: 45 }, stop], 15);
    expect(plans[0]).toMatchObject({ arriveAt: t("10:15"), departAt: t("11:00") });
    expect(plans[1].arriveAt).toEqual(t("11:15"));
  });
  it("returns nothing for a trip without stops", () => {
    expect(computeStopPlans(t("10:00"), [], [], 15)).toEqual([]);
  });
  it("rejects mismatched lengths", () => {
    expect(() => computeStopPlans(t("10:00"), [60], [stop, stop], 15)).toThrow();
  });
});
