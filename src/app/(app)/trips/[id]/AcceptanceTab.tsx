import { Badge, Card, EmptyState } from "@/components/ui";
import { can } from "@/domain/permissions";
import { formatQty } from "@/domain/qty";
import { formatInTz } from "@/domain/time";
import type { UserCtx } from "@/server/auth/requireCtx";
import { listAcceptance, REASON_LABELS } from "@/server/services/acceptance";
import { listTasks } from "@/server/services/tasks";
import { listAssignableUsers } from "@/server/services/users";
import type { TripView } from "@/server/services/trips";
import { AcceptanceForm, CompleteTaskForm } from "./AcceptanceForms";

const ACCEPTING = ["in_progress", "completed"];

export async function AcceptanceTab({ ctx, trip }: { ctx: UserCtx; trip: TripView }) {
  const tz = trip.stops[0].location.tz;
  const canEdit = can(ctx.actor.role, "execution.write") && ACCEPTING.includes(trip.status);
  const [{ current, history }, tasks, people] = await Promise.all([
    listAcceptance(ctx, trip.id),
    listTasks(ctx, { tripId: trip.id }),
    listAssignableUsers(ctx),
  ]);
  const currentByCargo = new Map(current.map((c) => [c.tripCargoId, c]));
  const rows = trip.stops.flatMap((s) => s.cargo.map((c) => ({ stop: s, cargo: c })));

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState>В рейсе нет груза.</EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {!canEdit && (
        <p className="text-gray-600">Приёмку вносят после выезда рейса и до финансового закрытия, ролям склада и логистики.</p>
      )}

      {rows.map(({ stop, cargo }) => {
        const acc = currentByCargo.get(cargo.id) ?? null;
        const base = cargo.loadedMilli ?? cargo.qtyMilli;
        return (
          <Card key={`${cargo.id}:${acc?.versionNo ?? 0}`} className="space-y-3 p-4">
            <div data-testid={`acceptance-row-${cargo.orderNumber}`} className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold">
                  {cargo.orderNumber} → {stop.location.name}
                </h2>
                <span className="text-sm text-gray-600">
                  {cargo.product ?? "Груз"}: {cargo.loadedMilli != null ? `погружено ${formatQty(cargo.loadedMilli)} из ${formatQty(cargo.qtyMilli)}` : `по плану ${formatQty(cargo.qtyMilli)}`} {cargo.unit ?? ""}
                </span>
              </div>
              {acc ? (
                <p className="text-sm">
                  <Badge tone={acc.acceptedMilli < base ? "amber" : "green"}>версия {acc.versionNo}</Badge>{" "}
                  принято {formatQty(acc.acceptedMilli)}, отклонено {formatQty(acc.rejectedMilli)}, возвращено {formatQty(acc.returnedMilli)}
                  {acc.reasonCode ? `, причина: ${REASON_LABELS[acc.reasonCode]}` : ""}
                  {acc.confirmation ? `, подтверждение: ${acc.confirmation}` : ""}
                </p>
              ) : (
                <p className="text-sm text-gray-500">Приёмка ещё не внесена.</p>
              )}
              <AcceptanceForm
                tripId={trip.id}
                tz={tz}
                cargoId={cargo.id}
                baseMilli={base}
                unit={cargo.unit}
                people={people.map((p) => ({ id: p.id, name: p.name }))}
                current={acc}
                canEdit={canEdit}
              />
            </div>
          </Card>
        );
      })}

      <section aria-label="Задачи по отклонениям" className="space-y-2">
        <h2 className="font-semibold">Задачи</h2>
        {tasks.length === 0 ? (
          <p className="text-gray-500">Задач по этому рейсу нет.</p>
        ) : (
          <div data-testid="task-list" className="space-y-2">
            {tasks.map((t) => (
              <Card key={t.id} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{t.title}</span>
                  <Badge tone={t.status === "open" ? "amber" : "green"}>{t.status === "open" ? "открыта" : "закрыта"}</Badge>
                </div>
                <div className="text-xs text-gray-500">
                  {t.responsibleName ? `Ответственный: ${t.responsibleName}` : "Без ответственного"}
                  {t.dueAt ? `, срок ${formatInTz(t.dueAt, tz, "dd.MM.yyyy")}` : ""}
                </div>
                {t.resolution && <div className="mt-1 text-sm text-gray-700">Решение: {t.resolution}</div>}
                {t.status === "open" && canEdit && <CompleteTaskForm tripId={trip.id} taskId={t.id} />}
              </Card>
            ))}
          </div>
        )}
      </section>

      {history.length > 0 && (
        <details>
          <summary className="cursor-pointer font-semibold">История версий</summary>
          <ul data-testid="acceptance-history" className="mt-2 space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.id}>
                {h.orderNumber}: версия {h.versionNo}, принято {formatQty(h.acceptedMilli)}, отклонено {formatQty(h.rejectedMilli)}, возвращено {formatQty(h.returnedMilli)}
                {h.reasonCode ? ` (${REASON_LABELS[h.reasonCode]})` : ""} · {h.createdByName}, {formatInTz(h.createdAt, tz, "dd.MM HH:mm")}
                {h.isCurrent ? " · текущая" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
