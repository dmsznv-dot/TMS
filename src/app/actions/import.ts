"use server";

import { DomainError } from "@/domain/errors";
import { suggestMapping, type OrderField, type OrderMapping, type RowError } from "@/domain/importMapping";
import { requireCan } from "@/server/auth/context";
import {
  createImportJob,
  enqueueImportJob,
  fixImportRow,
  getImportJob,
  saveTemplate,
  validateImportJob,
} from "@/server/import/jobs";
import { parseTable } from "@/server/import/parse";
import { run, type ActionResult } from "./run";

async function fileOf(formData: FormData): Promise<{ filename: string; bytes: Buffer }> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new DomainError("validation", "Выберите файл");
  }
  return { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
}

export type SheetHeaders = {
  name: string;
  headers: string[];
  suggested: Partial<Record<OrderField, string>>;
};

/** Reads the column headers of a sample file for the template editor. */
export async function readHeadersAction(formData: FormData): Promise<ActionResult<SheetHeaders[]>> {
  return run(async (ctx) => {
    requireCan(ctx, "settings.manage");
    const { filename, bytes } = await fileOf(formData);
    const { sheets } = await parseTable(bytes, filename);
    return sheets
      .filter((s) => s.headers.length > 0)
      .map((s) => ({ name: s.name, headers: s.headers, suggested: suggestMapping(s.headers) }));
  });
}

export async function saveTemplateAction(
  name: string,
  mapping: OrderMapping,
): Promise<ActionResult<{ templateId: string }>> {
  return run((ctx) => saveTemplate(ctx, { name, mapping }), ["/import"]);
}

/** Stores the rows of the uploaded file and checks them; no orders are written yet. */
export async function uploadImportAction(formData: FormData): Promise<ActionResult<{ jobId: string }>> {
  return run(
    async (ctx) => {
      const { filename, bytes } = await fileOf(formData);
      const templateId = String(formData.get("templateId") ?? "");
      if (!templateId) throw new DomainError("validation", "Выберите шаблон");
      const { jobId } = await createImportJob(ctx, { filename, bytes, templateId });
      await validateImportJob(ctx, jobId);
      return { jobId };
    },
    ["/import"],
  );
}

export async function applyImportAction(jobId: string): Promise<ActionResult> {
  return run((ctx) => enqueueImportJob(ctx, jobId), [`/import/${jobId}`]);
}

export async function importStatusAction(jobId: string): Promise<ActionResult<{ status: string }>> {
  return run(async (ctx) => ({ status: (await getImportJob(ctx, jobId)).status }));
}

export async function fixImportRowAction(
  jobId: string,
  rowId: string,
  raw: Record<string, unknown>,
): Promise<ActionResult<{ status: "applied" | "error"; errors: RowError[] }>> {
  return run((ctx) => fixImportRow(ctx, { rowId, raw }), [`/import/${jobId}`]);
}
