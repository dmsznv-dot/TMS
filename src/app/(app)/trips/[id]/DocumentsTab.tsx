import { Badge, Card, EmptyState } from "@/components/ui";
import { can } from "@/domain/permissions";
import { formatInTz } from "@/domain/time";
import type { UserCtx } from "@/server/auth/requireCtx";
import { DOCUMENT_STATUS_LABELS, listDocuments } from "@/server/services/finance";
import type { TripView } from "@/server/services/trips";
import { DocumentForm, DocumentStatusSelect } from "./DocumentForms";

export async function DocumentsTab({ ctx, trip }: { ctx: UserCtx; trip: TripView }) {
  const docs = await listDocuments(ctx, trip.id);
  const canEdit = (can(ctx.actor.role, "planning.write") || can(ctx.actor.role, "money.write")) && trip.status !== "cancelled";
  const tz = trip.stops[0].location.tz;

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">Документы вводятся вручную: номер, ссылка у оператора и статус. Обмен с оператором ЭПД подключается позже.</p>
      {docs.length === 0 ? (
        <Card>
          <EmptyState>Документов нет.</EmptyState>
        </Card>
      ) : (
        docs.map((d) => (
          <Card key={d.id} className="space-y-2 p-4">
            <div data-testid="document-card" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">
                  {d.kind}
                  {d.number ? ` № ${d.number}` : ""}
                </h2>
                <Badge tone={d.status === "signed" ? "green" : d.status === "rejected" ? "red" : "gray"}>{DOCUMENT_STATUS_LABELS[d.status]}</Badge>
              </div>
              {d.operatorRef && <p className="text-sm text-gray-700">У оператора: {d.operatorRef}</p>}
              {canEdit && <DocumentStatusSelect tripId={trip.id} documentId={d.id} status={d.status} />}
              <ul data-testid="document-log" className="text-xs text-gray-500">
                {d.log.map((l, i) => (
                  <li key={i}>
                    {formatInTz(new Date(l.at), tz, "dd.MM HH:mm")} — {DOCUMENT_STATUS_LABELS[l.status]}
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        ))
      )}
      {canEdit && (
        <Card className="p-4">
          <h2 className="mb-3 font-semibold">Новый документ</h2>
          <DocumentForm tripId={trip.id} />
        </Card>
      )}
    </div>
  );
}
