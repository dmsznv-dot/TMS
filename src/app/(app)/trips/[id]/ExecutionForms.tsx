"use client";

import { useState } from "react";
import {
  confirmLoadingAction,
  createShareLinkAction,
  revokeShareLinkAction,
  setMileageAction,
  setStopFactAction,
  skipStopAction,
} from "@/app/actions/execution";
import { Badge, Button, Card, ErrorText, inputClass, inputInlineClass } from "@/components/ui";
import { useAction } from "@/components/useAction";
import { formatQty, parseQty } from "@/domain/qty";
import { formatInTz, zonedToUtc } from "@/domain/time";
import type { TripView } from "@/server/services/trips";

const LOCAL = "yyyy-MM-dd'T'HH:mm";

type LinkRow = { id: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null; expired: boolean };

export function ShareLinkPanel({ tripId, links, canCreate, tz }: { tripId: string; links: LinkRow[]; canCreate: boolean; tz: string }) {
  // Anyone who sees this panel may revoke; creating needs a trip that is still going out.
  const { error, pending, run } = useAction();
  const [created, setCreated] = useState<string | null>(null);

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Ссылка для водителя или подрядчика</h2>
      <p className="text-xs text-gray-500">По ссылке открывается только этот рейс: точки, контакты, инструкции и отметки. Денег там нет.</p>

      {canCreate && (
        <Button
          disabled={pending}
          onClick={() =>
            run(async () => {
              const result = await createShareLinkAction(tripId, 3);
              if (result.ok) setCreated(`${window.location.origin}/d/${result.data.token}`);
              return result;
            })
          }
        >
          Создать ссылку для водителя
        </Button>
      )}

      {created && (
        <div className="space-y-1">
          <input data-testid="share-url" readOnly className={inputClass} value={created} onFocus={(e) => e.currentTarget.select()} />
          <p className="text-xs text-amber-800">Скопируйте ссылку сейчас: позже она не показывается, сохраняется только её отпечаток.</p>
        </div>
      )}

      <ErrorText>{error}</ErrorText>

      {links.length > 0 && (
        <ul className="space-y-1 text-sm">
          {links.map((l) => {
            const expired = l.expired;
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Создана {formatInTz(l.createdAt, tz, "dd.MM HH:mm")}, до {formatInTz(l.expiresAt, tz, "dd.MM HH:mm")}{" "}
                  {l.revokedAt ? <Badge tone="red">отозвана</Badge> : expired ? <Badge>истекла</Badge> : <Badge tone="green">действует</Badge>}
                </span>
                {!l.revokedAt && !expired && (
                  <Button variant="secondary" disabled={pending} onClick={() => run(() => revokeShareLinkAction(tripId, l.id))}>
                    Отозвать
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function LoadingForm({ trip, canEdit }: { trip: TripView; canEdit: boolean }) {
  const { error, pending, run } = useAction();
  const cargo = trip.stops.flatMap((s) => s.cargo.map((c) => ({ ...c, stopName: s.location.name })));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(cargo.map((c) => [c.id, formatQty(c.loadedMilli ?? c.qtyMilli)])),
  );

  function save() {
    const items: { tripCargoId: string; loadedMilli: number }[] = [];
    for (const c of cargo) {
      const parsed = parseQty(values[c.id] ?? "");
      if (parsed == null) return run(async () => ({ ok: false, message: `Погружено по заказу ${c.orderNumber}: неверное число` }));
      items.push({ tripCargoId: c.id, loadedMilli: parsed });
    }
    run(() => confirmLoadingAction(trip.id, items));
  }

  if (cargo.length === 0) return null;
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Погрузка</h2>
      <div className="space-y-2">
        {cargo.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3">
            <span className="min-w-56 flex-1">
              {c.orderNumber} → {c.stopName}: {c.product ?? "груз"}, план {formatQty(c.qtyMilli)} {c.unit ?? ""}
            </span>
            <input
              aria-label={`Погружено по заказу ${c.orderNumber}`}
              className={`${inputInlineClass} w-28`}
              inputMode="decimal"
              disabled={!canEdit}
              value={values[c.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [c.id]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      {canEdit && (
        <Button variant="secondary" onClick={save} disabled={pending}>
          Подтвердить погрузку
        </Button>
      )}
    </Card>
  );
}

function StopRow({ trip, stop, canEdit }: { trip: TripView; stop: TripView["stops"][number]; canEdit: boolean }) {
  const tz = stop.location.tz;
  const { error, pending, run } = useAction();
  const [arrive, setArrive] = useState(stop.actualArriveAt ? formatInTz(stop.actualArriveAt, tz, LOCAL) : "");
  const [depart, setDepart] = useState(stop.actualDepartAt ? formatInTz(stop.actualDepartAt, tz, LOCAL) : "");
  const [reason, setReason] = useState("");

  return (
    <li className="space-y-2 rounded-md border border-gray-200 p-3">
      <div className="font-medium">
        {stop.seq}. {stop.location.name}
      </div>
      {stop.skippedReason ? (
        <p className="text-red-700">Не состоялась: {stop.skippedReason}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">Прибыл</span>
            <input type="datetime-local" className={inputClass} disabled={!canEdit} value={arrive} onChange={(e) => setArrive(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-gray-500">{stop.operation === "load" ? "Выехал после погрузки" : "Разгружен, выехал"}</span>
            <input type="datetime-local" className={inputClass} disabled={!canEdit} value={depart} onChange={(e) => setDepart(e.target.value)} />
          </label>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {canEdit && !stop.skippedReason && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            disabled={pending || (!arrive && !depart)}
            onClick={() =>
              run(() => setStopFactAction(trip.id, stop.id, arrive ? zonedToUtc(arrive, tz) : null, depart ? zonedToUtc(depart, tz) : null))
            }
          >
            Сохранить факт
          </Button>
          {stop.operation !== "load" && !stop.actualDepartAt && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-600">Остановка не состоялась</summary>
              <div className="mt-2 flex gap-2">
                <input aria-label="Причина, почему остановка не состоялась" className={inputClass} placeholder="Причина" value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button variant="danger" disabled={pending} onClick={() => run(() => skipStopAction(trip.id, stop.id, reason))}>
                  Отметить
                </Button>
              </div>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

export function StopFacts({ trip, canEdit }: { trip: TripView; canEdit: boolean }) {
  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Фактическое время по остановкам</h2>
      <ol className="space-y-3">
        {trip.stops.map((stop) => (
          <StopRow key={`${stop.id}:${stop.actualArriveAt?.getTime()}:${stop.actualDepartAt?.getTime()}`} trip={trip} stop={stop} canEdit={canEdit} />
        ))}
      </ol>
    </Card>
  );
}

export function MileageForm({ trip, canEdit }: { trip: TripView; canEdit: boolean }) {
  const { error, pending, run } = useAction();
  const [km, setKm] = useState(trip.mileageKm != null ? String(trip.mileageKm).replace(".", ",") : "");
  const [unknown, setUnknown] = useState(trip.mileageUnknown);

  function save() {
    const value = unknown ? null : Number(km.replace(",", "."));
    if (!unknown && (km.trim() === "" || Number.isNaN(value))) return run(async () => ({ ok: false, message: "Укажите пробег числом или отметьте, что он неизвестен" }));
    run(() => setMileageAction(trip.id, value, unknown));
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="font-semibold">Пробег</h2>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <span>Пробег, км</span>
          <input className={`${inputInlineClass} w-28`} inputMode="decimal" disabled={!canEdit || unknown} value={km} onChange={(e) => setKm(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled={!canEdit} checked={unknown} onChange={(e) => setUnknown(e.target.checked)} />
          Пробег неизвестен
        </label>
        {canEdit && (
          <Button variant="secondary" onClick={save} disabled={pending}>
            Сохранить пробег
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
