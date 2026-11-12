import { Card } from "@/components/ui";
import { can } from "@/domain/permissions";
import { formatInTz } from "@/domain/time";
import type { UserCtx } from "@/server/auth/requireCtx";
import { EVENT_LABELS, listTripEvents } from "@/server/services/execution";
import { listShareLinks } from "@/server/services/shareLinks";
import type { TripView } from "@/server/services/trips";
import { LoadingForm, MileageForm, ShareLinkPanel, StopFacts } from "./ExecutionForms";

const LINKABLE = ["planned", "assigned", "in_progress"];
const FACT_EDITABLE = ["assigned", "in_progress", "completed"];

export async function ExecutionTab({ ctx, trip }: { ctx: UserCtx; trip: TripView }) {
  const role = ctx.actor.role;
  const canPlan = can(role, "planning.write");
  const canExecute = can(role, "execution.write") && FACT_EDITABLE.includes(trip.status);
  const tz = trip.stops[0].location.tz;
  const [events, links] = await Promise.all([listTripEvents(ctx, trip.id), canPlan ? listShareLinks(ctx, trip.id) : []]);

  return (
    <div className="space-y-6">
      {canPlan && (
        <ShareLinkPanel tripId={trip.id} links={links} canCreate={LINKABLE.includes(trip.status)} tz={tz} />
      )}
      <LoadingForm trip={trip} canEdit={canExecute} />
      <StopFacts trip={trip} canEdit={canExecute} />
      <MileageForm trip={trip} canEdit={canExecute} />

      <Card className="space-y-2 p-4">
        <h2 className="font-semibold">Что произошло</h2>
        {events.length === 0 ? (
          <p className="text-gray-500">Отметок пока нет.</p>
        ) : (
          <ul data-testid="event-feed" className="space-y-1 text-sm">
            {events.map((e) => (
              <li key={e.id}>
                <span className="text-gray-500">{formatInTz(e.at, tz, "dd.MM HH:mm")}</span> {EVENT_LABELS[e.type]}
                {e.stopName ? `: ${e.stopName}` : ""} <span className="text-gray-500">· {e.actorName}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
