import type { QtyMilli } from "./qty";

export type OrderStatus =
  | "new"
  | "partially_planned"
  | "planned"
  | "partially_delivered"
  | "delivered"
  | "cancelled";

export type OrderLineProgress = {
  qty: QtyMilli;
  /** Quantity placed on trips that are not yet completed. */
  allocatedOpen: QtyMilli;
  /** Quantity accepted by the recipient. */
  delivered: QtyMilli;
};

/** The status of an order, computed from what is planned and what is accepted. */
export function deriveOrderStatus(lines: OrderLineProgress[], cancelled: boolean): OrderStatus {
  if (cancelled) return "cancelled";
  if (lines.length === 0) return "new";

  const allDelivered = lines.every((l) => l.delivered >= l.qty);
  if (allDelivered) return "delivered";

  const anyInTransit = lines.some((l) => l.allocatedOpen > 0);
  if (!anyInTransit) {
    return lines.some((l) => l.delivered > 0) ? "partially_delivered" : "new";
  }
  const allCovered = lines.every((l) => l.delivered + l.allocatedOpen >= l.qty);
  return allCovered ? "planned" : "partially_planned";
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Новый",
  partially_planned: "Частично запланирован",
  planned: "Запланирован",
  partially_delivered: "Частично доставлен",
  delivered: "Доставлен",
  cancelled: "Отменён",
};
