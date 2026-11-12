import Link from "next/link";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatInTz } from "@/domain/time";
import { requireCtx } from "@/server/auth/requireCtx";
import { getTriage, TRIAGE_LABELS, type TriageKind } from "@/server/services/triage";

export default async function TriagePage() {
  const ctx = await requireCtx();
  const items = await getTriage(ctx);
  const kinds = (Object.keys(TRIAGE_LABELS) as TriageKind[]).filter((k) => items.some((i) => i.kind === k));

  return (
    <>
      <PageHeader title="Разобрать" />
      {items.length === 0 ? (
        <Card>
          <EmptyState>Всё разобрано: опозданий, недопоставок, неразнесённых платежей и ошибок импорта нет.</EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {kinds.map((kind) => {
            const list = items.filter((i) => i.kind === kind);
            return (
              <section key={kind} aria-label={TRIAGE_LABELS[kind]} className="space-y-2">
                <h2 className="flex items-center gap-2 font-semibold">
                  {TRIAGE_LABELS[kind]} <Badge tone="amber">{list.length}</Badge>
                </h2>
                <Card>
                  <ul data-testid={`triage-${kind}`} className="divide-y divide-gray-100">
                    {list.map((item, i) => (
                      <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                        <Link href={item.href} className="text-blue-700 hover:underline">
                          {item.title}
                        </Link>
                        {item.dueAt && <span className="text-xs text-gray-500">срок {formatInTz(item.dueAt, "Europe/Moscow", "dd.MM.yyyy HH:mm")} МСК</span>}
                      </li>
                    ))}
                  </ul>
                </Card>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
