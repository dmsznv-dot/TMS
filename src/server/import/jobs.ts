import { createHash } from "node:crypto";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { DomainError, isDomainError } from "@/domain/errors";
import {
  DATE_FORMATS,
  mapOrderRow,
  ORDER_FIELDS,
  REQUIRED_ORDER_FIELDS,
  type OrderMapping,
  type ParsedOrderRow,
  type RowError,
} from "@/domain/importMapping";
import { requireCan, type Ctx } from "../auth/context";
import type { Db } from "../db/client";
import {
  importJobs,
  importRows,
  importTemplates,
  locations,
  users,
  type ImportCounts,
  type ImportRowStatus,
} from "../db/schema";
import { audit, inTransaction } from "../services/audit";
import { upsertOrder, type UpsertResult } from "../services/orders";
import { parseInput } from "../services/validation";
import { parseTable } from "./parse";

const MAX_ROWS = 20_000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const mappingSchema = z.object({
  columns: z
    .partialRecord(z.enum(ORDER_FIELDS), z.string().trim().min(1))
    .refine((columns) => REQUIRED_ORDER_FIELDS.every((f) => columns[f]), {
      message: "Сопоставьте все обязательные поля: номер, точка, окно, количество",
    }),
  dateFormat: z.enum(DATE_FORMATS),
  timezone: z.string().refine((tz) => tz === "location" || isTimeZone(tz), "Неизвестный часовой пояс"),
});

const templateInput = z.object({
  name: z.string().trim().min(1, "Укажите название шаблона"),
  mapping: mappingSchema,
});

// --- stored row values -------------------------------------------------------

/** JSON has no date type, so spreadsheet dates are stored as { $date: ISO }. */
function encodeRaw(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, v instanceof Date ? { $date: v.toISOString() } : v]),
  );
}

function decodeRaw(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => {
      const date = (v as { $date?: unknown } | null)?.$date;
      return [k, typeof date === "string" ? new Date(date) : v];
    }),
  );
}

// --- templates ---------------------------------------------------------------

/** Creates a template, or replaces the mapping of the one with the same name. */
export async function saveTemplate(
  ctx: Ctx,
  input: { name: string; mapping: OrderMapping },
): Promise<{ templateId: string }> {
  requireCan(ctx, "settings.manage");
  const data = parseInput(templateInput, input);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(importTemplates)
      .values({ orgId: tx.orgId, name: data.name, mapping: data.mapping as OrderMapping })
      .onConflictDoUpdate({
        target: [importTemplates.orgId, importTemplates.name],
        set: { mapping: data.mapping as OrderMapping },
      })
      .returning({ id: importTemplates.id });
    await audit(tx, { entity: "import_template", entityId: row.id, action: "save", after: data });
    return { templateId: row.id };
  });
}

export async function listTemplates(ctx: Ctx) {
  requireCan(ctx, "trips.read");
  return ctx.db
    .select({ id: importTemplates.id, name: importTemplates.name, mapping: importTemplates.mapping })
    .from(importTemplates)
    .where(eq(importTemplates.orgId, ctx.orgId))
    .orderBy(asc(importTemplates.name));
}

async function templateOf(ctx: Ctx, templateId: string) {
  const [template] = await ctx.db
    .select()
    .from(importTemplates)
    .where(and(eq(importTemplates.id, templateId), eq(importTemplates.orgId, ctx.orgId)));
  if (!template) throw new DomainError("not_found", "Шаблон импорта не найден");
  return template;
}

// --- jobs --------------------------------------------------------------------

async function jobOf(ctx: Ctx, jobId: string) {
  const [job] = await ctx.db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, jobId), eq(importJobs.orgId, ctx.orgId)));
  if (!job) throw new DomainError("not_found", "Загрузка не найдена");
  return job;
}

/**
 * Reads the file and stores its rows for checking. The file itself is not
 * kept. `duplicateOfJobId` names an earlier finished upload of the same bytes.
 */
export async function createImportJob(
  ctx: Ctx,
  input: { filename: string; bytes: Buffer; sheetName?: string; templateId: string },
): Promise<{ jobId: string; duplicateOfJobId: string | null; rowCount: number }> {
  const actor = requireCan(ctx, "planning.write");
  const template = await templateOf(ctx, input.templateId);

  const { sheets } = await parseTable(input.bytes, input.filename);
  const sheet = input.sheetName
    ? sheets.find((s) => s.name === input.sheetName)
    : (sheets.find((s) => s.rows.length > 0) ?? sheets[0]);
  if (!sheet) throw new DomainError("not_found", "Лист не найден в файле");
  if (sheet.rows.length === 0) throw new DomainError("empty_file", "В файле нет строк с данными");
  if (sheet.rows.length > MAX_ROWS) {
    throw new DomainError("too_many_rows", `В файле больше ${MAX_ROWS} строк. Разделите его на части.`);
  }

  const fileSha256 = createHash("sha256").update(input.bytes).digest("hex");

  return inTransaction(ctx, async (tx) => {
    const [previous] = await tx.db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.orgId, tx.orgId),
          eq(importJobs.templateId, template.id),
          eq(importJobs.fileSha256, fileSha256),
          eq(importJobs.status, "done"),
        ),
      )
      .orderBy(desc(importJobs.createdAt))
      .limit(1);

    const [job] = await tx.db
      .insert(importJobs)
      .values({
        orgId: tx.orgId,
        templateId: template.id,
        filename: input.filename,
        sheetName: sheet.name,
        fileSha256,
        createdBy: actor.userId,
      })
      .returning({ id: importJobs.id });

    const rows = sheet.rows.map((raw, i) => ({
      orgId: tx.orgId,
      jobId: job.id,
      rowNo: i + 2,
      raw: encodeRaw(raw),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await tx.db.insert(importRows).values(rows.slice(i, i + 500));
    }
    return { jobId: job.id, duplicateOfJobId: previous?.id ?? null, rowCount: rows.length };
  });
}

type CheckedRow = { id: string; parsed: ParsedOrderRow | null; errors: RowError[] };

async function locationResolver(ctx: Ctx) {
  const rows = await ctx.db
    .select({ id: locations.id, tz: locations.tz, name: locations.name, externalKey: locations.externalKey })
    .from(locations)
    .where(and(eq(locations.orgId, ctx.orgId), eq(locations.active, true)));
  const byKey = new Map<string, { id: string; tz: string }>();
  for (const r of rows) byKey.set(r.name.trim().toLowerCase(), { id: r.id, tz: r.tz });
  // An explicit key wins over a name that happens to look the same.
  for (const r of rows) if (r.externalKey) byKey.set(r.externalKey.trim().toLowerCase(), { id: r.id, tz: r.tz });
  return (key: string) => byKey.get(key.trim().toLowerCase()) ?? null;
}

/** Maps every row of the job and records which are valid; writes no orders. */
async function checkRows(ctx: Ctx, jobId: string, mapping: OrderMapping): Promise<CheckedRow[]> {
  const resolve = await locationResolver(ctx);
  const rows = await ctx.db.select().from(importRows).where(eq(importRows.jobId, jobId)).orderBy(asc(importRows.rowNo));

  const seenLines = new Set<string>();
  const headers = new Map<string, ParsedOrderRow>();
  const checked: CheckedRow[] = [];

  for (const row of rows) {
    const result = mapOrderRow(decodeRaw(row.raw), mapping, resolve);
    let errors: RowError[] = result.ok ? [] : result.errors;
    let parsed = result.ok ? result.value : null;

    if (parsed) {
      const first = headers.get(parsed.number);
      const lineId = `${parsed.number}\u0000${parsed.lineKey}`;
      if (seenLines.has(lineId)) {
        errors = [{ field: "row", code: "duplicate_line", message: "Строка заказа повторяется в файле" }];
      } else if (
        first &&
        (first.locationId !== parsed.locationId ||
          first.windowStart.getTime() !== parsed.windowStart.getTime() ||
          first.windowEnd.getTime() !== parsed.windowEnd.getTime())
      ) {
        errors = [
          { field: "row", code: "order_header_mismatch", message: "Точка или окно отличаются от первой строки этого заказа" },
        ];
      } else {
        seenLines.add(lineId);
        if (!first) headers.set(parsed.number, parsed);
      }
      if (errors.length > 0) parsed = null;
    }

    await ctx.db
      .update(importRows)
      .set({ status: parsed ? "valid" : "error", errors, result: null })
      .where(eq(importRows.id, row.id));
    checked.push({ id: row.id, parsed, errors });
  }
  return checked;
}

async function refreshCounts(ctx: Ctx, jobId: string): Promise<ImportCounts> {
  const rows = await ctx.db
    .select({ status: importRows.status, result: importRows.result, n: sql<number>`count(*)::int` })
    .from(importRows)
    .where(eq(importRows.jobId, jobId))
    .groupBy(importRows.status, importRows.result);
  const counts: ImportCounts = { added: 0, updated: 0, skipped: 0, errors: 0 };
  for (const r of rows) {
    if (r.status === "error") counts.errors += r.n;
    else if (r.status === "applied" && r.result) counts[r.result] += r.n;
  }
  await ctx.db.update(importJobs).set({ counts }).where(eq(importJobs.id, jobId));
  return counts;
}

/** Checks the file against the template and the reference data without writing orders. */
export async function validateImportJob(ctx: Ctx, jobId: string): Promise<{ valid: number; errors: number }> {
  requireCan(ctx, "planning.write");
  const job = await jobOf(ctx, jobId);
  if (job.status === "queued" || job.status === "processing") {
    throw new DomainError("job_busy", "Загрузка уже обрабатывается");
  }
  const template = await templateOf(ctx, job.templateId);
  return inTransaction(ctx, async (tx) => {
    const checked = await checkRows(tx, jobId, template.mapping);
    await tx.db.update(importJobs).set({ status: "validated", error: null }).where(eq(importJobs.id, jobId));
    const errors = checked.filter((r) => !r.parsed).length;
    return { valid: checked.length - errors, errors };
  });
}

/** Puts the job into the processing queue. */
export async function enqueueImportJob(ctx: Ctx, jobId: string): Promise<void> {
  requireCan(ctx, "planning.write");
  const job = await jobOf(ctx, jobId);
  if (job.status === "queued" || job.status === "processing") return;
  await ctx.db
    .update(importJobs)
    .set({ status: "queued", error: null, finishedAt: null })
    .where(eq(importJobs.id, jobId));
}

function rowResult(order: UpsertResult, lineResults: Record<string, UpsertResult>, lineKey: string): UpsertResult {
  if (order === "added") return "added";
  const headerChanged = order === "updated" && Object.values(lineResults).every((r) => r === "skipped");
  return headerChanged ? "updated" : (lineResults[lineKey] ?? "skipped");
}

async function applyRows(ctx: Ctx, templateId: string, rows: CheckedRow[]): Promise<void> {
  const groups = new Map<string, { id: string; parsed: ParsedOrderRow }[]>();
  for (const row of rows) {
    if (!row.parsed) continue;
    const group = groups.get(row.parsed.number) ?? [];
    group.push({ id: row.id, parsed: row.parsed });
    groups.set(row.parsed.number, group);
  }

  for (const [number, group] of groups) {
    const head = group[0].parsed;
    try {
      const { result, lineResults } = await upsertOrder(ctx, {
        source: `template:${templateId}`,
        number,
        locationId: head.locationId,
        customerName: head.customerName,
        windowStart: head.windowStart,
        windowEnd: head.windowEnd,
        lines: group.map(({ parsed }) => ({
          lineKey: parsed.lineKey,
          product: parsed.product,
          unit: parsed.unit,
          qtyMilli: parsed.qty,
          weightKgMilli: parsed.weightKgMilli,
          volumeM3Milli: parsed.volumeM3Milli,
          palletsMilli: parsed.palletsMilli,
          priceKop: parsed.priceKop,
          costKop: parsed.costKop,
        })),
      });
      for (const { id, parsed } of group) {
        await ctx.db
          .update(importRows)
          .set({ status: "applied", errors: [], result: rowResult(result, lineResults, parsed.lineKey) })
          .where(eq(importRows.id, id));
      }
    } catch (e) {
      if (!isDomainError(e)) throw e;
      const errors: RowError[] = [{ field: "row", code: e.code, message: e.message }];
      for (const { id } of group) {
        await ctx.db.update(importRows).set({ status: "error", errors, result: null }).where(eq(importRows.id, id));
      }
    }
  }
}

/**
 * Takes one queued job and applies it. Returns false when the queue is
 * empty. A job left in "processing" by a crashed process is picked up again
 * after ten minutes; applying a job twice changes nothing.
 */
export async function processNextJob(db: Db): Promise<boolean> {
  const job = await db.transaction(async (tx) => {
    const [next] = await tx
      .select()
      .from(importJobs)
      .where(
        or(
          eq(importJobs.status, "queued"),
          and(eq(importJobs.status, "processing"), lt(importJobs.startedAt, new Date(Date.now() - STALE_PROCESSING_MS))),
        ),
      )
      .orderBy(asc(importJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return null;
    await tx.update(importJobs).set({ status: "processing", startedAt: new Date() }).where(eq(importJobs.id, next.id));
    return next;
  });
  if (!job) return false;

  try {
    const [creator] = await db.select({ role: users.role }).from(users).where(eq(users.id, job.createdBy));
    if (!creator) throw new Error("job creator no longer exists");
    const ctx: Ctx = { db, orgId: job.orgId, actor: { kind: "user", userId: job.createdBy, role: creator.role } };
    const template = await templateOf(ctx, job.templateId);

    const checked = await checkRows(ctx, job.id, template.mapping);
    await applyRows(ctx, job.templateId, checked);
    await refreshCounts(ctx, job.id);
    await db.update(importJobs).set({ status: "done", finishedAt: new Date(), error: null }).where(eq(importJobs.id, job.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(importJobs)
      .set({ status: "failed", finishedAt: new Date(), error: message.slice(0, 500) })
      .where(eq(importJobs.id, job.id));
  }
  return true;
}

// --- reading and fixing ------------------------------------------------------

export async function getImportJob(ctx: Ctx, jobId: string) {
  requireCan(ctx, "trips.read");
  const job = await jobOf(ctx, jobId);
  const template = await templateOf(ctx, job.templateId);
  const stats = await ctx.db
    .select({ status: importRows.status, n: sql<number>`count(*)::int` })
    .from(importRows)
    .where(eq(importRows.jobId, jobId))
    .groupBy(importRows.status);
  const rowStats = { pending: 0, valid: 0, error: 0, applied: 0 };
  for (const s of stats) rowStats[s.status] = s.n;
  const n = rowStats.pending + rowStats.valid + rowStats.error + rowStats.applied;

  const [earlier] = await ctx.db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(
      and(
        eq(importJobs.orgId, ctx.orgId),
        eq(importJobs.templateId, job.templateId),
        eq(importJobs.fileSha256, job.fileSha256),
        eq(importJobs.status, "done"),
        lt(importJobs.createdAt, job.createdAt),
      ),
    )
    .orderBy(desc(importJobs.createdAt))
    .limit(1);

  return {
    id: job.id,
    /** An earlier finished upload of the same file, if there was one. */
    duplicateOfJobId: earlier?.id ?? null,
    rowStats,
    filename: job.filename,
    sheetName: job.sheetName,
    status: job.status,
    counts: job.counts,
    error: job.error,
    rowCount: n,
    templateId: template.id,
    templateName: template.name,
    mapping: template.mapping,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

export async function listImportJobs(ctx: Ctx) {
  requireCan(ctx, "trips.read");
  return ctx.db
    .select({
      id: importJobs.id,
      filename: importJobs.filename,
      status: importJobs.status,
      counts: importJobs.counts,
      createdAt: importJobs.createdAt,
      templateName: importTemplates.name,
    })
    .from(importJobs)
    .innerJoin(importTemplates, eq(importTemplates.id, importJobs.templateId))
    .where(eq(importJobs.orgId, ctx.orgId))
    .orderBy(desc(importJobs.createdAt))
    .limit(50);
}

export async function listImportRows(ctx: Ctx, jobId: string, filter: { status?: ImportRowStatus } = {}) {
  requireCan(ctx, "trips.read");
  await jobOf(ctx, jobId);
  const conditions = [eq(importRows.jobId, jobId), eq(importRows.orgId, ctx.orgId)];
  if (filter.status) conditions.push(eq(importRows.status, filter.status));
  const rows = await ctx.db.select().from(importRows).where(and(...conditions)).orderBy(asc(importRows.rowNo)).limit(1000);
  return rows.map((r) => ({
    id: r.id,
    rowNo: r.rowNo,
    raw: decodeRaw(r.raw),
    status: r.status,
    errors: r.errors,
    result: r.result,
  }));
}

/** Replaces the values of one row, checks it and, when valid, applies it on its own. */
export async function fixImportRow(
  ctx: Ctx,
  input: { rowId: string; raw: Record<string, unknown> },
): Promise<{ status: "applied" | "error"; errors: RowError[] }> {
  requireCan(ctx, "planning.write");
  const [row] = await ctx.db
    .select()
    .from(importRows)
    .where(and(eq(importRows.id, input.rowId), eq(importRows.orgId, ctx.orgId)));
  if (!row) throw new DomainError("not_found", "Строка не найдена");
  const job = await jobOf(ctx, row.jobId);
  const template = await templateOf(ctx, job.templateId);

  const result = mapOrderRow(input.raw, template.mapping, await locationResolver(ctx));
  const raw = encodeRaw(input.raw);

  if (!result.ok) {
    await ctx.db.update(importRows).set({ raw, status: "error", errors: result.errors, result: null }).where(eq(importRows.id, row.id));
    await refreshCounts(ctx, job.id);
    return { status: "error", errors: result.errors };
  }

  await ctx.db.update(importRows).set({ raw }).where(eq(importRows.id, row.id));
  await applyRows(ctx, job.templateId, [{ id: row.id, parsed: result.value, errors: [] }]);
  await refreshCounts(ctx, job.id);

  const [after] = await ctx.db.select().from(importRows).where(eq(importRows.id, row.id));
  return { status: after.status === "applied" ? "applied" : "error", errors: after.errors };
}

