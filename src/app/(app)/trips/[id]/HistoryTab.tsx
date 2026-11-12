import { Card, EmptyState } from "@/components/ui";
import { formatInTz } from "@/domain/time";
import type { UserCtx } from "@/server/auth/requireCtx";
import { listTripHistory } from "@/server/services/history";
import type { TripView } from "@/server/services/trips";

export async function HistoryTab({ ctx, trip }: { ctx: UserCtx; trip: TripView }) {
  const history = await listTripHistory(ctx, trip.id);
  const tz = trip.stops[0].location.tz;
  return (
    <Card>
      {history.length === 0 ? (
        <EmptyState>Записей нет.</EmptyState>
      ) : (
        <ul data-testid="history-list" className="divide-y divide-gray-100 text-sm">
          {history.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-3 px-4 py-2">
              <span className="w-32 shrink-0 text-gray-500">{formatInTz(h.at, tz, "dd.MM.yyyy HH:mm")}</span>
              <span className="min-w-0 flex-1">{h.line}</span>
              <span className="text-gray-500">{h.actorName}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
