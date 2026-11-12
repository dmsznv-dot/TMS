import { z } from "zod";
import { requireCan, type Ctx } from "../auth/context";
import { parseInput } from "../services/validation";
import { buildDataset, DATASETS, DATASET_LABELS, type Dataset } from "./datasets";
import { toCsv, toXlsx } from "./writers";

export { DATASETS, DATASET_LABELS, type Dataset };

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_TYPE = "text/csv; charset=utf-8";

const requestSchema = z.object({
  dataset: z.enum(DATASETS, { error: "Неизвестный набор данных" }),
  format: z.enum(["xlsx", "csv"], { error: "Поддерживаются форматы XLSX и CSV" }),
});

/**
 * A dataset as a downloadable file. Money data needs money access; the other
 * sets leave money columns out for roles that may not see them.
 */
export async function exportDataset(
  ctx: Ctx,
  dataset: Dataset,
  format: "xlsx" | "csv",
): Promise<{ filename: string; contentType: string; body: Buffer }> {
  requireCan(ctx, "export.run");
  const request = parseInput(requestSchema, { dataset, format });
  const table = await buildDataset(ctx, request.dataset);
  const filename = `${request.dataset}-${new Date().toISOString().slice(0, 10)}.${request.format}`;
  return request.format === "xlsx"
    ? { filename, contentType: XLSX_TYPE, body: await toXlsx(table, DATASET_LABELS[request.dataset]) }
    : { filename, contentType: CSV_TYPE, body: toCsv(table) };
}
