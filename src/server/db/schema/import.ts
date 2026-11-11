import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { OrderMapping, RowError } from "@/domain/importMapping";
import { organizations, users } from "./org";

export type ImportCounts = { added: number; updated: number; skipped: number; errors: number };
export type ImportJobStatus = "uploaded" | "validated" | "queued" | "processing" | "done" | "failed";
export type ImportRowStatus = "pending" | "valid" | "error" | "applied";

export const importTemplates = pgTable(
  "import_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    fileType: text("file_type").$type<"orders">().notNull().default("orders"),
    mapping: jsonb("mapping").$type<OrderMapping>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("import_template_name").on(t.orgId, t.name)],
);

export const importJobs = pgTable(
  "import_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    templateId: uuid("template_id").notNull().references(() => importTemplates.id),
    filename: text("filename").notNull(),
    sheetName: text("sheet_name"),
    /** Hash of the uploaded bytes; the file itself is not kept. */
    fileSha256: text("file_sha256").notNull(),
    status: text("status").$type<ImportJobStatus>().notNull().default("uploaded"),
    counts: jsonb("counts").$type<ImportCounts>(),
    error: text("error"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("import_job_queue_idx").on(t.status, t.createdAt)],
);

export const importRows = pgTable(
  "import_row",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    jobId: uuid("job_id").notNull().references(() => importJobs.id),
    /** Row number in the file; the header is row 1. */
    rowNo: integer("row_no").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<ImportRowStatus>().notNull().default("pending"),
    errors: jsonb("errors").$type<RowError[]>().notNull().default([]),
    result: text("result").$type<"added" | "updated" | "skipped">(),
  },
  (t) => [index("import_row_job_idx").on(t.jobId, t.rowNo)],
);
