import type { ExpenseCategory } from "./costEstimate";

export type CompletenessCode =
  | "acceptance_missing"
  | "mileage_missing"
  | "fact_expense_missing"
  | "unverified_expense"
  | "unbilled_surcharge"
  | "open_task";

export type CompletenessInput = {
  cargoWithoutAcceptance: number;
  /** Mileage is entered, or marked as unknown. */
  mileageKnownOrMarked: boolean;
  /** Planned expense categories that have neither an actual amount nor a "did not occur" mark. */
  planCategoriesWithoutFact: ExpenseCategory[];
  unverifiedExpenses: number;
  /** Agreed surcharges not yet put on an invoice. */
  unbilledSurcharges: number;
  openTasks: number;
};

export const COMPLETENESS_LABELS: Record<CompletenessCode, string> = {
  acceptance_missing: "По части груза нет приёмки",
  mileage_missing: "Не указан пробег и не отмечено, что он неизвестен",
  fact_expense_missing: "По плановым статьям нет факта и нет отметки «не было»",
  unverified_expense: "Есть непроверенные расходы",
  unbilled_surcharge: "Есть согласованные доплаты без счёта",
  open_task: "Есть открытые задачи по рейсу",
};

/** Whether the data of a completed trip is whole enough to close it financially, and what is missing. */
export function checkCompleteness(i: CompletenessInput): { ok: boolean; failed: CompletenessCode[] } {
  const failed: CompletenessCode[] = [];
  if (i.cargoWithoutAcceptance > 0) failed.push("acceptance_missing");
  if (!i.mileageKnownOrMarked) failed.push("mileage_missing");
  if (i.planCategoriesWithoutFact.length > 0) failed.push("fact_expense_missing");
  if (i.unverifiedExpenses > 0) failed.push("unverified_expense");
  if (i.unbilledSurcharges > 0) failed.push("unbilled_surcharge");
  if (i.openTasks > 0) failed.push("open_task");
  return { ok: failed.length === 0, failed };
}
