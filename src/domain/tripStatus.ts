export type TripStatus = "draft" | "planned" | "assigned" | "in_progress" | "completed" | "closed" | "cancelled";

/** What is currently true of a trip; the caller gathers it before asking for a transition. */
export type TripFacts = {
  hasCargoStops: boolean;
  hasCurrentPlan: boolean;
  /** An own vehicle and driver are set, or a carrier offer is confirmed. */
  executorReady: boolean;
  hasExecutionEvent: boolean;
  /** Every stop has an actual time or a "did not happen" mark with a reason. */
  allStopsResolved: boolean;
  completenessOk: boolean;
  overrideReason: string | null;
  cancelReason: string | null;
};

export type TransitionCheck = { ok: true } | { ok: false; code: string };

const filled = (s: string | null) => s != null && s.trim() !== "";
const INVALID: TransitionCheck = { ok: false, code: "invalid_transition" };
const BEFORE_COMPLETED: TripStatus[] = ["draft", "planned", "assigned", "in_progress"];

/** Whether a trip may move between two statuses. Statuses of other entities are independent. */
export function checkTransition(from: TripStatus, to: TripStatus, f: TripFacts): TransitionCheck {
  if (to === "cancelled") {
    if (!BEFORE_COMPLETED.includes(from)) return INVALID;
    return filled(f.cancelReason) ? { ok: true } : { ok: false, code: "cancel_reason_required" };
  }

  if (from === "draft" && to === "planned") {
    if (!f.hasCargoStops) return { ok: false, code: "no_cargo" };
    if (!f.hasCurrentPlan) return { ok: false, code: "no_plan" };
    return { ok: true };
  }
  if (from === "planned" && to === "assigned") {
    return f.executorReady ? { ok: true } : { ok: false, code: "executor_not_ready" };
  }
  // Changing the executor after assignment sends the trip back to planning.
  if (from === "assigned" && to === "planned") return { ok: true };
  if (from === "assigned" && to === "in_progress") {
    return f.hasExecutionEvent ? { ok: true } : { ok: false, code: "no_execution_event" };
  }
  if (from === "in_progress" && to === "completed") {
    return f.allStopsResolved ? { ok: true } : { ok: false, code: "stops_unresolved" };
  }
  if (from === "completed" && to === "closed") {
    return f.completenessOk || filled(f.overrideReason) ? { ok: true } : { ok: false, code: "incomplete" };
  }
  return INVALID;
}

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  draft: "Черновик",
  planned: "Запланирован",
  assigned: "Назначен",
  in_progress: "В работе",
  completed: "Выполнен",
  closed: "Финансово закрыт",
  cancelled: "Отменён",
};

/** Trips in these statuses hold their cargo: the quantity is not available for other trips. */
export const OPEN_TRIP_STATUSES: TripStatus[] = ["draft", "planned", "assigned", "in_progress"];
