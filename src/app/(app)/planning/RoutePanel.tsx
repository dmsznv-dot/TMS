"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  assignAction,
  calculateAction,
  optionsAction,
  savePlanAction,
} from "@/app/actions/planning";
import { QuotaBadge } from "@/components/QuotaBadge";
import { RouteMap } from "@/components/RouteMap";
import { WindowBadge } from "@/components/StatusBadges";
import { TwoGisAttribution } from "@/components/TwoGisAttribution";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  inputClass,
  tableClass,
  tdClass,
  thClass,
} from "@/components/ui";
import { readOtherCost, readToll, type TollState } from "@/domain/costEstimate";
import { formatDuration, formatKm } from "@/domain/format";
import { formatRub } from "@/domain/money";
import { formatInTz } from "@/domain/time";
import type { Quota } from "@/server/routing/quota";
import type { OfferView } from "@/server/services/offers";
import type {
  CalculateResult,
  ExcludedVehicle,
  ExecutorOptionRow,
} from "@/server/services/planning";
import type { DriverRow, VehicleRow } from "@/server/services/refs";
import type { TripView } from "@/server/services/trips";

type CurrentPlan = {
  versionNo: number;
  executorLabel: string;
  totalKop: number;
} | null;
type Variants = Extract<CalculateResult["result"], { ok: true }>["variants"];

type Props = {
  trip: TripView;
  vehicles: VehicleRow[];
  drivers: DriverRow[];
  offers: OfferView[];
  quota: Quota;
  plan: CurrentPlan;
  /** Wall-clock "yyyy-MM-ddTHH:mm" at the loading point. */
  defaultDeparture: string;
  tileUrl: string;
};

const TOLL_CHOICES = [
  { value: "unknown", label: "неизвестно" },
  { value: "none", label: "платных участков нет" },
  { value: "amount", label: "указать сумму" },
] as const;

export function RoutePanel({
  trip,
  vehicles,
  drivers,
  offers,
  quota: initialQuota,
  plan,
  defaultDeparture,
  tileUrl,
}: Props) {
  const router = useRouter();
  const tz = trip.stops[0].location.tz;
  const stopNames = trip.stops.slice(1).map((s) => s.location.name);

  // Until the planner types a time, the suggestion follows the delivery windows of the cargo on the trip.
  const [departureEdit, setDepartureEdit] = useState<string | null>(null);
  const departure = departureEdit ?? defaultDeparture;
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? "");
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const [avoidToll, setAvoidToll] = useState(false);
  const [quota, setQuota] = useState(initialQuota);

  const [calc, setCalc] = useState<CalculateResult | null>(null);
  const [rows, setRows] = useState<ExecutorOptionRow[]>([]);
  const [excluded, setExcluded] = useState<ExcludedVehicle[]>([]);
  const [chosenId, setChosenId] = useState<string | null>(null);

  const [driverId, setDriverId] = useState("");
  const [tollKind, setTollKind] = useState<TollState["kind"]>("unknown");
  const [tollRub, setTollRub] = useState("");
  const [otherRub, setOtherRub] = useState("");

  const [manual, setManual] = useState(false);
  const [manualKm, setManualKm] = useState("");
  const [manualMin, setManualMin] = useState("");
  const [manualExecutor, setManualExecutor] = useState("");

  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const variants: Variants = calc?.result.ok ? calc.result.variants : [];
  const chosen = rows.find((r) => r.id === chosenId) ?? null;
  const shownVariant = variants[chosen?.variantIndex ?? 0] ?? null;
  const usableOffers = offers.filter(
    (o) => o.status === "quoted" || o.status === "confirmed",
  );

  /** Toll and other costs as typed; an unreadable amount is shown as an error and is never taken as zero. */
  const costs = (kind = tollKind): { toll: TollState; other: number } | null => {
    const toll = readToll(kind, tollRub);
    if (!toll.ok) {
      setError(toll.message);
      return null;
    }
    const other = readOtherCost(otherRub);
    if (!other.ok) {
      setError(other.message);
      return null;
    }
    return { toll: toll.toll, other: other.kop };
  };
  const reloadOptions = (list: Variants, kind = tollKind) => {
    const c = costs(kind);
    if (c) loadOptions(list, c.toll, c.other);
  };

  function loadOptions(list: Variants, toll: TollState, other: number) {
    startTransition(async () => {
      const result = await optionsAction({
        tripId: trip.id,
        departureLocal: departure,
        variants: list.map((v) => ({ token: v.token, toll, otherKop: other })),
      });
      if (!result.ok) return setError(result.message);
      setRows(result.data.rows);
      setExcluded(result.data.excluded);
      setChosenId((current) =>
        result.data.rows.some((r) => r.id === current) ? current : null,
      );
    });
  }

  function calculate(confirmFar: boolean) {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const result = await calculateAction({
        tripId: trip.id,
        departureLocal: departure,
        vehicleId: vehicleId || null,
        avoidToll,
        confirmFar,
      });
      if (!result.ok) return setError(result.message);
      setCalc(result.data);
      setQuota(result.data.quota);
      setProfileNote(vehicles.find((v) => v.id === vehicleId)?.plate ?? null);
      setRows([]);
      setExcluded([]);
      setChosenId(null);
      if (result.data.result.ok)
        reloadOptions(result.data.result.variants);
    });
  }

  function save() {
    setError(null);
    setSaved(null);
    let executor: Parameters<typeof savePlanAction>[0]["executor"];
    let route: Parameters<typeof savePlanAction>[0]["route"];

    if (manual) {
      const km = Number(manualKm.replace(",", "."));
      const min = Number(manualMin.replace(",", "."));
      if (!(km > 0) || !(min > 0))
        return setError("Укажите расстояние и время в пути для ручной оценки");
      route = {
        kind: "manual",
        distanceM: Math.round(km * 1000),
        durationS: Math.round(min * 60),
      };
      if (!manualExecutor) return setError("Выберите исполнителя");
      const [kind, id] = manualExecutor.split(":");
      if (kind === "offer") executor = { kind: "carrier", offerId: id };
      else {
        if (!driverId) return setError("Выберите водителя");
        executor = { kind: "own", vehicleId: id, driverId };
      }
    } else {
      if (!chosen) return setError("Выберите вариант в таблице");
      route = { kind: "sealed", token: variants[chosen.variantIndex].token };
      if (chosen.executor === "carrier")
        executor = { kind: "carrier", offerId: chosen.offerId! };
      else {
        if (!driverId) return setError("Выберите водителя");
        executor = { kind: "own", vehicleId: chosen.vehicleId!, driverId };
      }
    }

    const c = costs();
    if (!c) return;
    startTransition(async () => {
      const result = await savePlanAction({
        tripId: trip.id,
        expectedVersion: trip.version,
        reason: reason.trim() || null,
        departureLocal: departure,
        executor,
        route,
        toll: c.toll,
        otherKop: c.other,
      });
      if (!result.ok) return setError(result.message);
      setSaved(`План сохранён: версия ${result.data.versionNo}`);
      setCalc(null);
      setRows([]);
      setChosenId(null);
      setReason("");
      router.refresh();
    });
  }

  function assign() {
    setError(null);
    startTransition(async () => {
      const result = await assignAction(trip.id, trip.version);
      if (!result.ok) return setError(result.message);
      setSaved("Рейс назначен");
      router.refresh();
    });
  }

  const locked = !(
    trip.status === "draft" ||
    trip.status === "planned" ||
    trip.status === "assigned"
  );
  const hasCargo = trip.stops.some((s) => s.cargo.length > 0);

  return (
    <section aria-label="Маршрут и исполнитель" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Маршрут и исполнитель</h2>
        <QuotaBadge quota={quota} />
      </div>

      {plan && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
          <p data-testid="current-plan">
            Текущий план: версия {plan.versionNo}, {plan.executorLabel},{" "}
            {formatRub(plan.totalKop)}
          </p>
          {trip.status === "planned" && (
            <Button onClick={assign} disabled={pending}>
              Назначить
            </Button>
          )}
        </Card>
      )}

      {saved && (
        <p
          data-testid="plan-saved"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-green-800"
        >
          {saved}
        </p>
      )}

      <RouteMap
        stops={trip.stops.map((s) => ({
          lat: s.location.lat,
          lon: s.location.lon,
          label: s.location.name,
        }))}
        lines={shownVariant?.geometry ?? null}
        tileUrl={tileUrl}
      />

      {locked ? (
        <p className="text-gray-600">Рейс в этом статусе не перепланируется.</p>
      ) : (
        <Card className="space-y-3 p-3">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block font-medium">Выезд со склада</span>
              <input
                type="datetime-local"
                className={inputClass}
                value={departure}
                onChange={(e) => setDepartureEdit(e.target.value)}
              />
              <span className="mt-1 block text-xs text-gray-500">
                Время на точке погрузки ({tz}), после погрузки
              </span>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">
                Машина для грузового профиля
              </span>
              <select
                className={inputClass}
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
              >
                <option value="">— без профиля —</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.plate}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                checked={avoidToll}
                onChange={(e) => setAvoidToll(e.target.checked)}
              />
              <span>Без платных дорог</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => calculate(false)}
              disabled={pending || !hasCargo || !departure}
            >
              Рассчитать маршрут
            </Button>
            {!hasCargo && (
              <span className="text-xs text-gray-500">
                Сначала добавьте заказы в рейс.
              </span>
            )}
            <label className="ml-auto flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={manual}
                onChange={(e) => setManual(e.target.checked)}
              />
              Ввести оценку вручную
            </label>
          </div>

          {calc?.warnings.map((w) => (
            <p
              key={w}
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
            >
              {w}
            </p>
          ))}
          {calc?.needsConfirmation && (
            <Button
              variant="secondary"
              onClick={() => calculate(true)}
              disabled={pending}
            >
              Всё равно отправить запрос
            </Button>
          )}
          {calc && !calc.result.ok && !calc.needsConfirmation && (
            <p
              data-testid="calc-failure"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800"
            >
              {calc.result.message}
            </p>
          )}
        </Card>
      )}

      {!locked && manual && (
        <Card className="space-y-3 p-3">
          <h3 className="font-medium">Ручная оценка</h3>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1 block">Расстояние, км</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={manualKm}
                onChange={(e) => setManualKm(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block">Время в пути, мин</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={manualMin}
                onChange={(e) => setManualMin(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block">Исполнитель</span>
              <select
                className={inputClass}
                value={manualExecutor}
                onChange={(e) => setManualExecutor(e.target.value)}
              >
                <option value="">— выберите —</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={`vehicle:${v.id}`}>
                    Своя: {v.plate}
                  </option>
                ))}
                {usableOffers.map((o) => (
                  <option key={o.id} value={`offer:${o.id}`}>
                    Подрядчик: {o.carrierName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-gray-500">
            Такая оценка будет помечена как «ручная оценка».
          </p>
        </Card>
      )}

      {!locked && variants.length > 0 && !manual && (
        <div className="space-y-2">
          <h3 className="font-medium">Варианты и исполнители</h3>
          <p className="text-xs text-gray-500">
            {profileNote
              ? `Маршрут рассчитан для грузового профиля машины ${profileNote}.`
              : "Маршрут рассчитан без грузового профиля."}{" "}
            Для другой машины пересчитайте маршрут с её профилем.
          </p>
          {rows.length === 0 && !pending && (
            <p
              data-testid="no-executors"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
            >
              Нет подходящих исполнителей на это время. Измените время выезда,
              добавьте предложение подрядчика или введите оценку вручную.
            </p>
          )}
          {rows.length > 0 && (
            <Card className="overflow-x-auto">
              <table className={tableClass}>
                <thead>
                  <tr>
                    <th className={thClass}>Исполнитель</th>
                    <th className={thClass}>Прибытие</th>
                    <th className={thClass}>Затраты</th>
                    <th className={thClass}>Итог</th>
                    <th className={thClass} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const variant = variants[row.variantIndex];
                    return (
                      <tr
                        key={row.id}
                        data-testid="option-row"
                        className={
                          row.id === chosenId ? "bg-blue-50" : undefined
                        }
                      >
                        <td className={tdClass}>
                          <div className="font-medium">{row.label}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-600">
                            {formatKm(variant.distanceM)},{" "}
                            {formatDuration(variant.durationS)}
                            {variant.source === "synthetic" ? (
                              <Badge>демо-расчёт, не 2ГИС</Badge>
                            ) : (
                              <TwoGisAttribution />
                            )}
                            {variant.tollFiltered && (
                              <Badge tone="blue">без платных</Badge>
                            )}
                            {!variant.profileComplete && (
                              <Badge tone="amber">профиль неполный</Badge>
                            )}
                            {variant.legsEstimated && (
                              <Badge tone="amber">
                                время до остановок оценено
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className={tdClass}>
                          {row.stops.map((s, i) => (
                            <div
                              key={i}
                              className="flex flex-wrap items-center gap-x-2"
                            >
                              <span>
                                {stopNames[i]}{" "}
                                {formatInTz(s.arriveAt, tz, "HH:mm")}
                              </span>
                              <WindowBadge
                                state={s.windowState}
                                lateMin={s.lateMin}
                              />
                            </div>
                          ))}
                        </td>
                        <td className={tdClass}>
                          <div className="whitespace-nowrap font-medium">
                            {formatRub(row.cost.totalKop)}
                          </div>
                          {row.cost.incomplete && (
                            <Badge tone="amber">неполная</Badge>
                          )}
                          {row.cost.lines.some((l) => l.isEstimate) && (
                            <Badge>оценка</Badge>
                          )}
                          <details className="mt-1 text-xs text-gray-600">
                            <summary className="cursor-pointer">
                              Допущения
                            </summary>
                            <ul className="mt-1 list-disc pl-4">
                              {row.cost.lines.map((l) => (
                                <li key={l.category}>
                                  {l.category}:{" "}
                                  {l.kop == null
                                    ? "неизвестно"
                                    : formatRub(l.kop)}
                                </li>
                              ))}
                              {row.cost.assumptions.map((a) => (
                                <li key={a}>{a}</li>
                              ))}
                            </ul>
                          </details>
                        </td>
                        <td className={tdClass}>
                          {row.fits ? (
                            <Badge tone="green">успевает</Badge>
                          ) : (
                            <span className="text-red-700">{row.reason}</span>
                          )}
                        </td>
                        <td className={tdClass}>
                          <Button
                            variant={
                              row.id === chosenId ? "primary" : "secondary"
                            }
                            onClick={() => setChosenId(row.id)}
                            aria-pressed={row.id === chosenId}
                          >
                            Выбрать
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
          {excluded.length > 0 && (
            <ul className="text-xs text-gray-600">
              {excluded.map((x) => (
                <li key={x.vehicleId}>
                  {x.plate} не предлагается: {x.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!locked && (rows.length > 0 || manual) && (
        <Card className="space-y-3 p-3">
          <div className="grid gap-3 md:grid-cols-4">
            <label className="block">
              <span className="mb-1 block font-medium">Водитель</span>
              <select
                className={inputClass}
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
              >
                <option value="">— выберите —</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Платные дороги</span>
              <select
                className={inputClass}
                value={tollKind}
                onChange={(e) => {
                  const kind = e.target.value as TollState["kind"];
                  setTollKind(kind);
                  if (variants.length > 0 && !manual)
                    reloadOptions(variants, kind);
                }}
              >
                {TOLL_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {tollKind === "amount" && (
              <label className="block">
                <span className="mb-1 block font-medium">
                  Сумма платных дорог, ₽
                </span>
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={tollRub}
                  onChange={(e) => setTollRub(e.target.value)}
                  onBlur={() =>
                    variants.length > 0 &&
                    !manual &&
                    reloadOptions(variants)
                  }
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1 block font-medium">Прочие расходы, ₽</span>
              <input
                className={inputClass}
                inputMode="decimal"
                value={otherRub}
                onChange={(e) => setOtherRub(e.target.value)}
                onBlur={() =>
                  variants.length > 0 &&
                  !manual &&
                  reloadOptions(variants)
                }
              />
            </label>
          </div>

          {plan && (
            <label className="block">
              <span className="mb-1 block font-medium">
                Причина изменения плана
              </span>
              <input
                className={inputClass}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Например: сдвиг окна"
              />
            </label>
          )}

          <ErrorText>{error}</ErrorText>
          <Button onClick={save} disabled={pending}>
            Сохранить план
          </Button>
        </Card>
      )}

      {(locked || (rows.length === 0 && !manual)) && (
        <ErrorText>{error}</ErrorText>
      )}
    </section>
  );
}
