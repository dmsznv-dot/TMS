import type { QtyMilli } from "./qty";

/** How much of an order line can still be put on a trip. */
export function remainingToPlan(line: { qty: QtyMilli; delivered: QtyMilli; allocatedOpen: QtyMilli }): QtyMilli {
  return Math.max(0, line.qty - line.delivered - line.allocatedOpen);
}

export type AllocationCheck = { ok: true } | { ok: false; code: "non_positive" | "exceeds_remaining" };

export function checkAllocation(remaining: QtyMilli, requested: QtyMilli): AllocationCheck {
  if (requested <= 0) return { ok: false, code: "non_positive" };
  if (requested > remaining) return { ok: false, code: "exceeds_remaining" };
  return { ok: true };
}
