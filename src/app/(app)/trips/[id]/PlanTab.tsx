import Link from "next/link";
import { TwoGisAttribution } from "@/components/TwoGisAttribution";
import { WindowBadge } from "@/components/StatusBadges";
import { Badge, buttonClass, Card, EmptyState, tableClass, tdClass, thClass } from "@/components/ui";
import { EXPENSE_LABELS } from "@/domain/costEstimate";
import { formatDuration, formatKm } from "@/domain/format";
import { formatRub } from "@/domain/money";
import { can } from "@/domain/permissions";
import { formatInTz } from "@/domain/time";
import type { UserCtx } from "@/server/auth/requireCtx";
import { isPlanStale, listPlanVersions, type PlanVersionView } from "@/server/services/planning";
import type { TripView } from "@/server/services/trips";

const SOURCE_LABELS = { "2gis": "2ГИС", synthetic: "демо-расчёт, не 2ГИС", manual: "ручная оценка" } as const;

function Source({ plan }: { plan: PlanVersionView }) {
  return plan.metricsSource === "2gis" ? <TwoGisAttribution /> : <Badge>{SOURCE_LABELS[plan.metricsSource]}</Badge>;
}

function executorText(plan: PlanVersionView): string {
  return plan.executor === "own"
    ? `Своя машина ${plan.vehicle?.plate ?? "—"}, водитель ${plan.driver?.name ?? "—"}`
    : `Подрядчик ${plan.offer?.carrierName ?? "—"}`;
}

export async function PlanTab({ ctx, trip }: { ctx: UserCtx; trip: TripView }) {
  if (!can(ctx.actor.role, "money.read")) {
    return <p className="text-gray-600">План рейса с затратами доступен ролям, работающим с деньгами.</p>;
  }
  const versions = await listPlanVersions(ctx, trip.id);
  const current = versions.find((v) => v.isCurrent);
  const canPlan = can(ctx.actor.role, "planning.write");
  const tz = trip.stops[0].location.tz;

  if (!current) {
    return (
      <Card>
        <EmptyState>
          План ещё не сохранён.{" "}
          {canPlan && (
            <Link href={`/planning?trip=${trip.id}`} className="text-blue-700 hover:underline">
              Перейти к планированию
            </Link>
          )}
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-4">
        <div data-testid="plan-current" className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Текущий план: версия {current.versionNo}</h2>
            {canPlan && (
              <Link href={`/planning?trip=${trip.id}`} className={buttonClass("secondary")}>
                Перепланировать
              </Link>
            )}
          </div>
          <p>{executorText(current)}</p>
          <p className="flex flex-wrap items-center gap-2 text-gray-700">
            Выезд {formatInTz(current.departureAt, tz, "dd.MM.yyyy HH:mm")}, {formatKm(current.distanceM)}, {formatDuration(current.durationS)}
            <Source plan={current} />
            {!current.profileComplete && <Badge tone="amber">профиль машины неполный</Badge>}
            {current.legsEstimated && <Badge tone="amber">время до остановок оценено</Badge>}
            {current.tollFiltered && <Badge tone="blue">без платных дорог</Badge>}
          </p>
          {isPlanStale(current, trip) && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
              Состав остановок изменился после сохранения плана. Пересчитайте маршрут и сохраните новую версию.
            </p>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                {["Остановка", "Прибытие", "Ожидание", "Отъезд", "Окно"].map((h) => (
                  <th key={h} className={thClass}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {current.stops.map((s) => (
                <tr key={s.stopId}>
                  <td className={tdClass}>
                    {s.seq}. {s.locationName}
                  </td>
                  <td className={tdClass}>{s.arriveAt ? formatInTz(new Date(s.arriveAt), tz, "HH:mm") : "—"}</td>
                  <td className={tdClass}>{s.waitMin > 0 ? `${s.waitMin} мин` : "—"}</td>
                  <td className={tdClass}>{formatInTz(new Date(s.departAt), tz, "HH:mm")}</td>
                  <td className={tdClass}>{s.arriveAt ? <WindowBadge state={s.windowState} lateMin={s.lateMin} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="mb-2 font-medium">Затраты по плану</h3>
          <table className={tableClass}>
            <tbody>
              {current.costLines.map((l) => (
                <tr key={l.category}>
                  <td className={tdClass}>{EXPENSE_LABELS[l.category]}</td>
                  <td className={`${tdClass} text-right`}>{l.kop == null ? <Badge tone="amber">неизвестно</Badge> : formatRub(l.kop)}</td>
                </tr>
              ))}
              <tr>
                <td className={`${tdClass} font-semibold`}>Итого{current.incomplete ? " (неполная)" : ""}</td>
                <td className={`${tdClass} text-right font-semibold`}>{formatRub(current.totalKop)}</td>
              </tr>
            </tbody>
          </table>
          <ul className="mt-2 list-disc pl-5 text-xs text-gray-600">
            {current.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </Card>

      <div>
        <h2 className="mb-2 font-semibold">История версий</h2>
        <Card className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                {["Версия", "Сохранена", "Автор", "Причина", "Исполнитель", "Итого"].map((h) => (
                  <th key={h} className={thClass}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} data-testid="plan-version">
                  <td className={tdClass}>
                    {v.versionNo} {v.isCurrent && <Badge tone="green">текущая</Badge>}
                  </td>
                  <td className={tdClass}>{formatInTz(v.createdAt, tz, "dd.MM.yyyy HH:mm")}</td>
                  <td className={tdClass}>{v.createdByName}</td>
                  <td className={tdClass}>{v.reason ?? "—"}</td>
                  <td className={tdClass}>{executorText(v)}</td>
                  <td className={tdClass}>{formatRub(v.totalKop)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
