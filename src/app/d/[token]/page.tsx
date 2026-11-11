import { notFound } from "next/navigation";
import { formatQty } from "@/domain/qty";
import { formatInTz } from "@/domain/time";
import { rateLimit } from "@/server/auth/rateLimit";
import { getDb } from "@/server/db/client";
import { getDriverView } from "@/server/services/execution";
import { ctxFromShareToken } from "@/server/services/shareLinks";
import { DriverButton } from "./DriverActions";

const OPERATION = { load: "Погрузка", unload: "Разгрузка", return: "Возврат" } as const;

export default async function DriverPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await ctxFromShareToken(getDb(), token);
  if (!ctx || ctx.actor.kind !== "driver_link") notFound();

  if (!rateLimit(`page:${ctx.actor.linkId}`, 60)) {
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <p>Слишком много запросов. Подождите минуту и обновите страницу.</p>
      </main>
    );
  }

  const view = await getDriverView(ctx);
  const time = (d: Date | null, tz: string) => (d ? formatInTz(d, tz, "HH:mm") : null);

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <header>
        <h1 className="text-xl font-semibold">Рейс {view.tripNumber}</h1>
        <p className="text-sm text-gray-600">{view.canReport ? "Отметки передаются логисту сразу" : "Рейс завершён или не принимает отметок"}</p>
      </header>

      {!view.confirmed && view.canReport && <DriverButton token={token} type="driver_confirmed" label="Подтвердить назначение" />}
      {view.confirmed && <p className="rounded-md bg-green-50 px-3 py-2 text-green-800">Назначение подтверждено</p>}

      <div className="grid gap-2">
        <a href={view.navigatorUrl} className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-center font-medium">
          Открыть в Яндекс Навигаторе
        </a>
        <a href={view.mapsUrl} className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-center font-medium" target="_blank" rel="noreferrer">
          Открыть в Яндекс Картах
        </a>
        <p className="text-xs text-gray-500">
          Яндекс может построить другой путь. Проверьте грузовой профиль в приложении. Въезд на РЦ и инструкции ниже.
        </p>
      </div>

      <ol className="space-y-3">
        {view.stops.map((stop) => {
          const arrived = time(stop.actualArriveAt, stop.tz);
          const left = time(stop.actualDepartAt, stop.tz);
          return (
            <li key={stop.id} data-testid={`driver-stop-${stop.seq}`} className="space-y-2 rounded-lg border border-gray-200 bg-white p-3">
              <div>
                <div className="font-semibold">
                  {stop.seq}. {stop.name}
                </div>
                <div className="text-sm text-gray-600">{OPERATION[stop.operation]}</div>
                {stop.address && <div className="text-sm">{stop.address}</div>}
              </div>

              <dl className="space-y-1 text-sm">
                {stop.windowEnd && (
                  <div>
                    <dt className="inline text-gray-500">Окно: </dt>
                    <dd className="inline">
                      {time(stop.windowStart, stop.tz)}–{time(stop.windowEnd, stop.tz)}
                    </dd>
                  </div>
                )}
                {stop.plannedArriveAt && (
                  <div>
                    <dt className="inline text-gray-500">По плану: </dt>
                    <dd className="inline">{time(stop.plannedArriveAt, stop.tz)}</dd>
                  </div>
                )}
                {stop.contact && (
                  <div>
                    <dt className="inline text-gray-500">Контакт: </dt>
                    <dd className="inline">{stop.contact}</dd>
                  </div>
                )}
                {stop.entryNotes && (
                  <div>
                    <dt className="inline text-gray-500">Как заехать: </dt>
                    <dd className="inline">{stop.entryNotes}</dd>
                  </div>
                )}
                {stop.passRules && (
                  <div>
                    <dt className="inline text-gray-500">Пропуск: </dt>
                    <dd className="inline">{stop.passRules}</dd>
                  </div>
                )}
              </dl>

              {stop.cargo.length > 0 && (
                <ul className="text-sm text-gray-700">
                  {stop.cargo.map((c, i) => (
                    <li key={i}>
                      {c.product ?? "Груз"}: {formatQty(c.qtyMilli)} {c.unit ?? ""}
                    </li>
                  ))}
                </ul>
              )}

              {(arrived || left || stop.skippedReason) && (
                <p className="text-sm text-green-800">
                  {stop.skippedReason
                    ? `Не состоялась: ${stop.skippedReason}`
                    : [arrived && `Прибыл ${arrived}`, left && (stop.operation === "load" ? `Погружен ${left}` : `Разгружен ${left}`)].filter(Boolean).join(" · ")}
                </p>
              )}

              {view.canReport && !stop.skippedReason && !stop.actualDepartAt && (
                <div className="space-y-2">
                  {stop.operation === "load" ? (
                    <DriverButton token={token} type="loaded" stopId={stop.id} label="Погружен, выезжаю" />
                  ) : (
                    <>
                      {!stop.actualArriveAt && <DriverButton token={token} type="arrived" stopId={stop.id} label="Прибыл" />}
                      {stop.actualArriveAt && <DriverButton token={token} type="unloaded" stopId={stop.id} label="Разгружен" />}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
