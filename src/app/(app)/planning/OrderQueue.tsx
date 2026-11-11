"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addToTripAction } from "@/app/actions/planning";
import { Button, Card, EmptyState, ErrorText, inputClass } from "@/components/ui";
import { formatQty, parseQty } from "@/domain/qty";
import { formatInTz } from "@/domain/time";
import type { OrderView } from "@/server/services/orders";

type TripRef = { id: string; version: number; status: string } | null;

function OrderCard({ order, trip, canPlan }: { order: OrderView; trip: TripRef; canPlan: boolean }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.lines.map((l) => [l.id, formatQty(l.remainingMilli)])),
  );
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(order.lines.map((l) => [l.id, l.remainingMilli > 0])),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const editable = trip && (trip.status === "draft" || trip.status === "planned");

  function add() {
    if (!trip) return;
    setError(null);
    const items: { orderLineId: string; qtyMilli: number }[] = [];
    for (const line of order.lines) {
      if (!included[line.id] || line.remainingMilli <= 0) continue;
      const parsed = parseQty(qty[line.id] ?? "");
      if (parsed == null || parsed <= 0) return setError(`Укажите количество по строке «${line.product ?? line.lineKey}»`);
      items.push({ orderLineId: line.id, qtyMilli: parsed });
    }
    if (items.length === 0) return setError("Отметьте, что добавить в рейс");
    startTransition(async () => {
      const result = await addToTripAction(trip.id, trip.version, items);
      if (!result.ok) return setError(result.message);
      router.refresh();
    });
  }

  const tz = order.location.tz;
  return (
    <Card className="p-3" >
      <div data-testid={`order-${order.number}`} className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold">{order.number}</span>
          <span className="text-xs text-gray-500">
            {formatInTz(order.windowStart, tz, "dd.MM HH:mm")}–{formatInTz(order.windowEnd, tz, "HH:mm")}
          </span>
        </div>
        <div className="text-gray-600">{order.location.name}</div>
        {order.customerName && <div className="text-xs text-gray-500">{order.customerName}</div>}

        {order.lines.map((line) => (
          <div key={line.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={`Добавить ${line.product ?? line.lineKey}`}
              checked={included[line.id] ?? false}
              disabled={line.remainingMilli <= 0}
              onChange={(e) => setIncluded((v) => ({ ...v, [line.id]: e.target.checked }))}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate">{line.product ?? line.lineKey}</div>
              <div className="text-xs text-gray-500">
                осталось {formatQty(line.remainingMilli)} из {formatQty(line.qtyMilli)} {line.unit ?? ""}
              </div>
            </div>
            <input
              aria-label="Количество"
              inputMode="decimal"
              className={`${inputClass} w-20`}
              value={qty[line.id] ?? ""}
              disabled={line.remainingMilli <= 0}
              onChange={(e) => setQty((v) => ({ ...v, [line.id]: e.target.value }))}
            />
          </div>
        ))}

        <ErrorText>{error}</ErrorText>
        {canPlan && (
          <Button variant="secondary" onClick={add} disabled={pending || !editable} title={editable ? undefined : "Выберите или создайте рейс"}>
            Добавить в рейс
          </Button>
        )}
      </div>
    </Card>
  );
}

export function OrderQueue({ orders, trip, canPlan }: { orders: OrderView[]; trip: TripRef; canPlan: boolean }) {
  return (
    <section aria-label="Очередь заказов" className="space-y-3">
      <h2 className="font-semibold">Заказы</h2>
      {canPlan && !trip && <p className="text-xs text-gray-500">Чтобы добавлять заказы, выберите рейс или создайте новый.</p>}
      {orders.length === 0 ? (
        <Card>
          <EmptyState>Заказов, которые нужно развезти, нет. Загрузите их на странице «Импорт».</EmptyState>
        </Card>
      ) : (
        orders.map((order) => (
          <OrderCard
            key={`${order.id}:${order.lines.map((l) => l.remainingMilli).join(",")}`}
            order={order}
            trip={trip}
            canPlan={canPlan}
          />
        ))
      )}
    </section>
  );
}
