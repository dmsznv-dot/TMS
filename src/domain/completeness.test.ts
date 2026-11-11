import { describe, expect, it } from "vitest";
import { checkCompleteness, type CompletenessInput } from "./completeness";

const complete: CompletenessInput = {
  cargoWithoutAcceptance: 0,
  mileageKnownOrMarked: true,
  planCategoriesWithoutFact: [],
  unverifiedExpenses: 0,
  unbilledSurcharges: 0,
  openTasks: 0,
};

describe("checkCompleteness", () => {
  it("passes when nothing is missing", () => {
    expect(checkCompleteness(complete)).toEqual({ ok: true, failed: [] });
  });

  it.each([
    ["acceptance_missing", { cargoWithoutAcceptance: 2 }],
    ["mileage_missing", { mileageKnownOrMarked: false }],
    ["fact_expense_missing", { planCategoriesWithoutFact: ["fuel" as const] }],
    ["unverified_expense", { unverifiedExpenses: 1 }],
    ["unbilled_surcharge", { unbilledSurcharges: 1 }],
    ["open_task", { openTasks: 3 }],
  ])("fails with %s", (code, patch) => {
    expect(checkCompleteness({ ...complete, ...patch })).toEqual({ ok: false, failed: [code] });
  });

  it("lists every failed check in a fixed order", () => {
    const r = checkCompleteness({
      cargoWithoutAcceptance: 1,
      mileageKnownOrMarked: false,
      planCategoriesWithoutFact: ["tolls"],
      unverifiedExpenses: 4,
      unbilledSurcharges: 1,
      openTasks: 1,
    });
    expect(r.failed).toEqual(["acceptance_missing", "mileage_missing", "fact_expense_missing", "unverified_expense", "unbilled_surcharge", "open_task"]);
  });
});
