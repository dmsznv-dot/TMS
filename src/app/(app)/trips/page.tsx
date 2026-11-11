import Link from "next/link";
import { TripStatusBadge } from "@/components/StatusBadges";
import { Card, EmptyState, PageHeader, tableClass, tdClass, thClass } from "@/components/ui";
import { TRIP_STATUS_LABELS, type TripStatus } from "@/domain/tripStatus";
import { formatInTz } from "@/domain/time";
import { requireCtx } from "@/server/auth/requireCtx";
import { listTrips } from "@/server/services/trips";

const STATUSES = Object.keys(TRIP_STATUS_LABELS) as TripStatus[];

export default async function TripsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireCtx();
  const { status } = await searchParams;
  const filter = STATUSES.find((s) => s === status);
  const trips = await listTrips(ctx, { status: filter });

  return (
    <>
      <PageHeader title="Рейсы" />
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/trips" className={`rounded-full border px-3 py-1 ${!filter ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-700"}`}>
          Все
        </Link>
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={`/trips?status=${s}`}
            className={`rounded-full border px-3 py-1 ${filter === s ? "border-blue-600 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-700"}`}
          >
            {TRIP_STATUS_LABELS[s]}
          </Link>
        ))}
      </div>

      <Card className="overflow-x-auto">
        {trips.length === 0 ? (
          <EmptyState>Рейсов пока нет. Их создают на экране «Планирование».</EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                {["Рейс", "Состояние", "Остановок", "Позиций груза", "Создан"].map((h) => (
                  <th key={h} className={thClass}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr key={t.id}>
                  <td className={tdClass}>
                    <Link href={`/trips/${t.id}`} className="font-medium text-blue-700 hover:underline">
                      {t.number}
                    </Link>
                  </td>
                  <td className={tdClass}>
                    <TripStatusBadge status={t.status} />
                  </td>
                  <td className={tdClass}>{t.stopCount}</td>
                  <td className={tdClass}>{t.cargoCount}</td>
                  <td className={tdClass}>{formatInTz(t.createdAt, "Asia/Novosibirsk", "dd.MM.yyyy HH:mm")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
