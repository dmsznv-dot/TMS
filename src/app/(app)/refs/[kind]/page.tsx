import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, EmptyState, PageHeader, tableClass, tdClass, thClass } from "@/components/ui";
import { can } from "@/domain/permissions";
import { requireCtx } from "@/server/auth/requireCtx";
import { env } from "@/server/env";
import { isRefKind, REF_CONFIG, REF_DEFAULTS, REF_KINDS } from "../config";
import { AddRefPanel } from "../RefForms";

export default async function RefListPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!isRefKind(kind)) notFound();
  const ctx = await requireCtx();
  const config = REF_CONFIG[kind];
  const rows = await config.list(ctx);
  const canWrite = can(ctx.actor.role, "refs.write");
  const map = config.map ? { ...config.map, tileUrl: env.MAP_TILE_URL } : undefined;

  return (
    <>
      <PageHeader title={config.title} />
      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {REF_KINDS.map((k) => (
          <Link
            key={k}
            href={`/refs/${k}`}
            className={`-mb-px border-b-2 px-3 py-2 ${
              k === kind ? "border-blue-600 font-medium text-blue-700" : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            {REF_CONFIG[k].title}
          </Link>
        ))}
      </div>

      {canWrite && (
        <div className="mb-4 flex">
          <AddRefPanel kind={kind} fields={config.fields} map={map} defaults={REF_DEFAULTS[kind]} />
        </div>
      )}

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState>Записей пока нет.</EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                {config.columns.map((c) => (
                  <th key={c} className={thClass}>
                    {c}
                  </th>
                ))}
                <th className={thClass}>Состояние</th>
                {canWrite && <th className={thClass} />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {config.cells(row).map((cell, i) => (
                    <td key={i} className={tdClass}>
                      {cell}
                    </td>
                  ))}
                  <td className={tdClass}>
                    {row.active ? <Badge tone="green">Активна</Badge> : <Badge>Не используется</Badge>}
                  </td>
                  {canWrite && (
                    <td className={`${tdClass} text-right`}>
                      <Link href={`/refs/${kind}/${row.id}`} className="text-blue-700 hover:underline">
                        Изменить
                      </Link>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
