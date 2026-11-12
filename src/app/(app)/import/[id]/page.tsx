import Link from "next/link";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/Forbidden";
import { Badge, Card, PageHeader } from "@/components/ui";
import { isDomainError } from "@/domain/errors";
import { cellToText, ORDER_FIELDS } from "@/domain/importMapping";
import { can } from "@/domain/permissions";
import { requireCtx } from "@/server/auth/requireCtx";
import { getImportJob, listImportRows } from "@/server/import/jobs";
import { JOB_STATUS_LABELS, JOB_STATUS_TONES } from "../labels";
import { ApplyButton, ErrorRow } from "./JobControls";

function Count({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div data-testid={testId} className="text-2xl font-semibold">
        {value}
      </div>
    </div>
  );
}

export default async function ImportJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  if (!can(ctx.actor.role, "planning.write")) return <Forbidden />;

  const job = await getImportJob(ctx, id).catch((e: unknown) => {
    if (isDomainError(e) && e.code === "not_found") notFound();
    throw e;
  });
  const errorRows = await listImportRows(ctx, id, { status: "error" });

  const busy = job.status === "queued" || job.status === "processing";
  const processed = job.status === "done";
  const headers = ORDER_FIELDS.map((f) => job.mapping.columns[f]).filter((h): h is string => Boolean(h));

  return (
    <>
      <PageHeader title={`Загрузка: ${job.filename}`}>
        <Badge tone={JOB_STATUS_TONES[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
        <Link href="/import" className="text-blue-700 hover:underline">
          К импорту
        </Link>
      </PageHeader>

      <p className="mb-4 text-gray-600">
        Шаблон «{job.templateName}»{job.sheetName && job.sheetName !== "CSV" ? `, лист «${job.sheetName}»` : ""}, строк в файле: {job.rowCount}.
      </p>

      {job.duplicateOfJobId && (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          Файл уже загружался.{" "}
          <Link href={`/import/${job.duplicateOfJobId}`} className="underline">
            Открыть прошлую загрузку
          </Link>
          . Повторная загрузка не создаст дублей: неизменённые строки будут пропущены.
        </p>
      )}

      {job.status === "failed" && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
          Обработка прервалась: {job.error}. Записанные строки сохранены; загрузку можно запустить ещё раз.
        </p>
      )}

      {processed && job.counts ? (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Count label="Добавлено" value={job.counts.added} testId="count-added" />
          <Count label="Обновлено" value={job.counts.updated} testId="count-updated" />
          <Count label="Пропущено" value={job.counts.skipped} testId="count-skipped" />
          <Count label="С ошибками" value={job.counts.errors} testId="count-errors" />
        </div>
      ) : (
        <Card className="mb-4 space-y-3 p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>Готово к загрузке: {job.rowStats.valid + job.rowStats.applied}</span>
            <span>С ошибками: {job.rowStats.error}</span>
          </div>
          <ApplyButton jobId={job.id} busy={busy} label={job.status === "failed" ? "Запустить ещё раз" : "Загрузить заказы"} />
        </Card>
      )}

      {errorRows.length > 0 && (
        <>
          <h2 className="mb-2 font-semibold">Строки с ошибками</h2>
          {!processed && (
            <p className="mb-2 text-xs text-gray-500">
              Исправить строку можно после загрузки заказов: остальные строки от этого не зависят.
            </p>
          )}
          <Card>
            {errorRows.map((row) => (
              <ErrorRow
                key={row.id}
                jobId={job.id}
                rowId={row.id}
                rowNo={row.rowNo}
                headers={headers}
                values={Object.fromEntries(headers.map((h) => [h, cellToText(row.raw[h], job.mapping.dateFormat)]))}
                errors={row.errors}
                editable={processed}
              />
            ))}
          </Card>
        </>
      )}
    </>
  );
}
