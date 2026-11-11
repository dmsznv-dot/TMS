"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  cancelTripAction,
  createTripAction,
  removeCargoAction,
  reorderStopsAction,
} from "@/app/actions/planning";
import { TripStatusBadge } from "@/components/StatusBadges";
import { Button, Card, ErrorText, inputClass } from "@/components/ui";
import { formatQty } from "@/domain/qty";
import type { TripListItem, TripView } from "@/server/services/trips";

const OPERATION_LABELS = { load: "Погрузка", unload: "Разгрузка", return: "Возврат" } as const;

type Option = { id: string; name: string };

export function TripPanel({
  trip,
  trips,
  origins,
  canPlan,
}: {
  trip: TripView | null;
  trips: TripListItem[];
  origins: Option[];
  canPlan: boolean;
}) {
  const router = useRouter();
  const [origin, setOrigin] = useState(origins[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const editable = trip && (trip.status === "draft" || trip.status === "planned");

  function act(fn: () => Promise<{ ok: boolean; message?: string }>, then?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return setError(result.message ?? "Не удалось выполнить действие");
      then?.();
      router.refresh();
    });
  }

  function create() {
    setError(null);
    startTransition(async () => {
      const result = await createTripAction(origin);
      if (!result.ok) return setError(result.message);
      router.push(`/planning?trip=${result.data.tripId}`);
    });
  }

  function move(index: number, delta: number) {
    if (!trip) return;
    const ids = trip.stops.map((s) => s.id);
    const target = index + delta;
    if (target < 1 || target >= ids.length) return; // the loading stop stays first
    [ids[index], ids[target]] = [ids[target], ids[index]];
    act(() => reorderStopsAction(trip.id, trip.version, ids));
  }

  return (
    <section aria-label="Рейс" className="space-y-3">
      <h2 className="font-semibold">Рейс</h2>

      <label className="block">
        <span className="mb-1 block text-xs text-gray-500">Открыть рейс</span>
        <select
          aria-label="Рейс"
          className={inputClass}
          value={trip?.id ?? ""}
          onChange={(e) => router.push(e.target.value ? `/planning?trip=${e.target.value}` : "/planning")}
        >
          <option value="">— не выбран —</option>
          {trips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.number}
            </option>
          ))}
        </select>
      </label>

      {!trip && canPlan && (
        <Card className="space-y-2 p-3">
          <label className="block">
            <span className="mb-1 block font-medium">Точка погрузки</span>
            <select className={inputClass} value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {origins.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <ErrorText>{error}</ErrorText>
          <Button onClick={create} disabled={pending || !origin}>
            Создать рейс
          </Button>
          {origins.length === 0 && <p className="text-xs text-gray-500">Сначала добавьте склад в справочнике «Точки».</p>}
        </Card>
      )}

      {trip && (
        <Card className="space-y-3 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span data-testid="trip-number" className="text-lg font-semibold">
              {trip.number}
            </span>
            <span data-testid="trip-status">
              <TripStatusBadge status={trip.status} />
            </span>
          </div>

          <ol data-testid="stop-list" className="space-y-2">
            {trip.stops.map((stop, i) => (
              <li key={stop.id} className="rounded-md border border-gray-200 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {stop.seq}. {stop.location.name}
                    </div>
                    <div className="text-xs text-gray-500">{OPERATION_LABELS[stop.operation]}</div>
                  </div>
                  {canPlan && editable && i > 0 && trip.stops.length > 2 && (
                    <div className="flex gap-1">
                      <Button variant="ghost" aria-label="Выше" disabled={pending || i === 1} onClick={() => move(i, -1)}>
                        ↑
                      </Button>
                      <Button variant="ghost" aria-label="Ниже" disabled={pending || i === trip.stops.length - 1} onClick={() => move(i, 1)}>
                        ↓
                      </Button>
                    </div>
                  )}
                </div>
                {stop.cargo.map((c) => (
                  <div key={c.id} className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-700">
                    <span>
                      {c.orderNumber}: {c.product ?? "груз"}, {formatQty(c.qtyMilli)} {c.unit ?? ""}
                    </span>
                    {canPlan && editable && (
                      <Button
                        variant="ghost"
                        aria-label="Убрать из рейса"
                        disabled={pending}
                        onClick={() => act(() => removeCargoAction(trip.id, trip.version, c.id))}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                ))}
              </li>
            ))}
          </ol>

          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap items-center gap-3">
            <Link href={`/trips/${trip.id}`} className="text-blue-700 hover:underline">
              Открыть карточку рейса
            </Link>
            {canPlan && (
              <Button variant="ghost" onClick={() => router.push("/planning")}>
                Новый рейс
              </Button>
            )}
          </div>

          {canPlan && (trip.status === "draft" || trip.status === "planned" || trip.status === "assigned") && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-600">Отменить рейс</summary>
              <div className="mt-2 space-y-2">
                <input
                  aria-label="Причина отмены"
                  className={inputClass}
                  placeholder="Причина отмены"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <Button variant="danger" disabled={pending} onClick={() => act(() => cancelTripAction(trip.id, trip.version, reason), () => router.push("/planning"))}>
                  Отменить рейс
                </Button>
              </div>
            </details>
          )}
        </Card>
      )}
    </section>
  );
}
