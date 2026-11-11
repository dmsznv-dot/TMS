import Link from "next/link";
import { Forbidden } from "@/components/Forbidden";
import { Badge, buttonClass, Card, EmptyState, PageHeader, tableClass, tdClass, thClass } from "@/components/ui";
import { can } from "@/domain/permissions";
import { formatInTz } from "@/domain/time";
import { requireCtx } from "@/server/auth/requireCtx";
import { listImportJobs, listTemplates } from "@/server/import/jobs";
import { JOB_STATUS_LABELS, JOB_STATUS_TONES } from "./labels";
import { UploadForm } from "./UploadForm";

export default async function ImportPage() {
  const ctx = await requireCtx();
  if (!can(ctx.actor.role, "planning.write")) return <Forbidden />;
  const [templates, jobs] = await Promise.all([listTemplates(ctx), listImportJobs(ctx)]);

  return (
    <>
      <PageHeader title="Импорт заказов">
        {can(ctx.actor.role, "settings.manage") && (
          <Link href="/import/templates/new" className={buttonClass("secondary")}>
            Новый шаблон
          </Link>
        )}
      </PageHeader>

      <Card className="mb-6 p-4">
        <UploadForm templates={templates.map((t) => ({ id: t.id, name: t.name }))} />
      </Card>

      <h2 className="mb-2 font-semibold">Последние загрузки</h2>
      <Card className="overflow-x-auto">
        {jobs.length === 0 ? (
          <EmptyState>Файлы ещё не загружались.</EmptyState>
        ) : (
          <table className={tableClass}>
            <thead>
              <tr>
                {["Файл", "Шаблон", "Загружен", "Состояние", "Добавлено", "Обновлено", "Пропущено", "С ошибками"].map((h) => (
                  <th key={h} className={thClass}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className={tdClass}>
                    <Link href={`/import/${job.id}`} className="text-blue-700 hover:underline">
                      {job.filename}
                    </Link>
                  </td>
                  <td className={tdClass}>{job.templateName}</td>
                  <td className={tdClass}>{formatInTz(job.createdAt, "Asia/Novosibirsk", "dd.MM.yyyy HH:mm")}</td>
                  <td className={tdClass}>
                    <Badge tone={JOB_STATUS_TONES[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
                  </td>
                  <td className={tdClass}>{job.counts?.added ?? "—"}</td>
                  <td className={tdClass}>{job.counts?.updated ?? "—"}</td>
                  <td className={tdClass}>{job.counts?.skipped ?? "—"}</td>
                  <td className={tdClass}>{job.counts?.errors ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
