import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrderMapping } from "@/domain/importMapping";
import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import {
  createImportJob,
  enqueueImportJob,
  fixImportRow,
  getImportJob,
  listImportRows,
  listTemplates,
  processNextJob,
  saveTemplate,
  validateImportJob,
} from "@/server/import/jobs";
import { listOrders } from "@/server/services/orders";
import { createLocation } from "@/server/services/refs";
import { expectCode } from "../helpers/expectCode";
import { makeOrg } from "../helpers/factories";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

const mapping: OrderMapping = {
  columns: {
    number: "Номер",
    locationKey: "Точка",
    windowStart: "С",
    windowEnd: "До",
    qty: "Кол-во",
    product: "Товар",
  },
  dateFormat: "dd.MM.yyyy HH:mm",
  timezone: "location",
};

const HEADER = "Номер;Точка;С;До;Кол-во;Товар";
const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join("\n"), "utf8");
const THREE_ROWS = csv(
  "З-1;SHOP-1;12.11.2026 09:00;12.11.2026 14:00;10;Вода",
  "З-1;SHOP-1;12.11.2026 09:00;12.11.2026 14:00;4;Сок",
  "З-2;SHOP-1;13.11.2026 09:00;13.11.2026 14:00;7;Вода",
);

async function setup() {
  const org = await makeOrg(db);
  const admin = await org.as("admin");
  const logist = await org.as("logist");
  await createLocation(logist, {
    name: "Магазин 1",
    externalKey: "SHOP-1",
    lat: 55.05,
    lon: 82.95,
    tz: "Asia/Novosibirsk",
    kind: "customer",
  });
  const { templateId } = await saveTemplate(admin, { name: "Демо", mapping });
  return { org, admin, logist, templateId };
}

/** Uploads, validates, queues and processes one file. */
async function importFile(ctx: Ctx, templateId: string, bytes: Buffer, filename = "orders.csv") {
  const created = await createImportJob(ctx, { filename, bytes, templateId });
  const validation = await validateImportJob(ctx, created.jobId);
  await enqueueImportJob(ctx, created.jobId);
  while (await processNextJob(db)) {
    // drain the queue
  }
  return { ...created, validation, job: await getImportJob(ctx, created.jobId) };
}

describe("templates", () => {
  it("are saved by an administrator and listed for the logistician", async () => {
    const { logist, templateId } = await setup();
    expect((await listTemplates(logist)).map((t) => [t.id, t.name])).toEqual([[templateId, "Демо"]]);
    await expectCode(saveTemplate(logist, { name: "Свой", mapping }), "forbidden");
  });

  it("must map every required field", async () => {
    const { admin } = await setup();
    const columns = { ...mapping.columns };
    delete columns.qty;
    await expectCode(saveTemplate(admin, { name: "Неполный", mapping: { ...mapping, columns } }), "validation");
  });
});

describe("import", () => {
  it("imports rows and counts results", async () => {
    const { logist, templateId } = await setup();
    const { job, validation } = await importFile(logist, templateId, THREE_ROWS);

    expect(validation).toEqual({ valid: 3, errors: 0 });
    expect(job.status).toBe("done");
    expect(job.counts).toEqual({ added: 3, updated: 0, skipped: 0, errors: 0 });
    const orders = await listOrders(logist);
    expect(orders.map((o) => o.number).sort()).toEqual(["З-1", "З-2"]);
    expect(orders.find((o) => o.number === "З-1")!.lines).toHaveLength(2);
  });

  it("validation alone writes no orders", async () => {
    const { logist, templateId } = await setup();
    const { jobId } = await createImportJob(logist, { filename: "o.csv", bytes: THREE_ROWS, templateId });
    await validateImportJob(logist, jobId);
    expect(await listOrders(logist)).toEqual([]);
  });

  it("does not duplicate on a second upload of the same file", async () => {
    const { logist, templateId } = await setup();
    const first = await importFile(logist, templateId, THREE_ROWS);
    const second = await importFile(logist, templateId, THREE_ROWS);

    expect(first.duplicateOfJobId).toBeNull();
    expect(second.duplicateOfJobId).toBe(first.jobId);
    expect(second.job.counts).toEqual({ added: 0, updated: 0, skipped: 3, errors: 0 });
    expect(await listOrders(logist)).toHaveLength(2);
  });

  it("updates only the changed row when an edited file is uploaded", async () => {
    const { logist, templateId } = await setup();
    await importFile(logist, templateId, THREE_ROWS);
    const edited = csv(
      "З-1;SHOP-1;12.11.2026 09:00;12.11.2026 14:00;12;Вода",
      "З-1;SHOP-1;12.11.2026 09:00;12.11.2026 14:00;4;Сок",
      "З-2;SHOP-1;13.11.2026 09:00;13.11.2026 14:00;7;Вода",
    );
    const { job, duplicateOfJobId } = await importFile(logist, templateId, edited);

    expect(duplicateOfJobId).toBeNull();
    expect(job.counts).toEqual({ added: 0, updated: 1, skipped: 2, errors: 0 });
    const order = (await listOrders(logist)).find((o) => o.number === "З-1")!;
    expect(order.lines.find((l) => l.lineKey === "Вода")!.qtyMilli).toBe(12_000);
  });

  it("keeps error rows and applies the rest", async () => {
    const { logist, templateId } = await setup();
    const { job, jobId, validation } = await importFile(
      logist,
      templateId,
      csv(
        "З-1;SHOP-1;12.11.2026 09:00;12.11.2026 14:00;10;Вода",
        "З-9;NOWHERE;12.11.2026 09:00;12.11.2026 14:00;5;Вода",
      ),
    );

    expect(validation).toEqual({ valid: 1, errors: 1 });
    expect(job.counts).toEqual({ added: 1, updated: 0, skipped: 0, errors: 1 });
    const [bad] = await listImportRows(logist, jobId, { status: "error" });
    expect(bad.rowNo).toBe(3);
    expect(bad.errors).toEqual([expect.objectContaining({ field: "locationKey", code: "location_not_found" })]);
    expect((await listOrders(logist)).map((o) => o.number)).toEqual(["З-1"]);
  });

  it("fixes a single error row", async () => {
    const { logist, templateId } = await setup();
    const { jobId } = await importFile(
      logist,
      templateId,
      csv("З-9;NOWHERE;12.11.2026 09:00;12.11.2026 14:00;5;Вода"),
    );
    const [bad] = await listImportRows(logist, jobId, { status: "error" });

    const stillBad = await fixImportRow(logist, { rowId: bad.id, raw: { ...bad.raw, "Кол-во": "ноль" } });
    expect(stillBad.status).toBe("error");

    const fixed = await fixImportRow(logist, { rowId: bad.id, raw: { ...bad.raw, "Точка": "SHOP-1" } });
    expect(fixed).toEqual({ status: "applied", errors: [] });
    expect((await listOrders(logist)).map((o) => o.number)).toEqual(["З-9"]);
    expect((await getImportJob(logist, jobId)).counts).toEqual({ added: 1, updated: 0, skipped: 0, errors: 0 });
  });

  it("reports a line repeated within one order as an error", async () => {
    const { logist, templateId } = await setup();
    const { validation, jobId } = await importFile(
      logist,
      templateId,
      csv(
        "З-1;SHOP-1;12.11.2026 09:00;12.11.2026 14:00;10;Вода",
        "З-1;SHOP-1;12.11.2026 09:00;12.11.2026 14:00;3;Вода",
      ),
    );
    expect(validation).toEqual({ valid: 1, errors: 1 });
    const [bad] = await listImportRows(logist, jobId, { status: "error" });
    expect(bad.errors[0].code).toBe("duplicate_line");
  });

  it("preserves spreadsheet date cells between upload and processing", async () => {
    const { logist, templateId } = await setup();
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Заказы");
    ws.addRow(HEADER.split(";"));
    ws.addRow(["З-5", "SHOP-1", new Date(Date.UTC(2026, 10, 12, 9, 0)), new Date(Date.UTC(2026, 10, 12, 14, 0)), 3, "Вода"]);
    const { job } = await importFile(logist, templateId, Buffer.from(await wb.xlsx.writeBuffer()), "orders.xlsx");

    expect(job.counts).toEqual({ added: 1, updated: 0, skipped: 0, errors: 0 });
    const [order] = await listOrders(logist);
    expect(order.windowStart.toISOString()).toBe("2026-11-12T02:00:00.000Z");
  });

  it("is safe to process twice", async () => {
    const { logist, templateId } = await setup();
    const { jobId } = await importFile(logist, templateId, THREE_ROWS);
    await enqueueImportJob(logist, jobId);
    while (await processNextJob(db)) {
      // drain
    }
    expect((await getImportJob(logist, jobId)).counts).toEqual({ added: 0, updated: 0, skipped: 3, errors: 0 });
    expect(await listOrders(logist)).toHaveLength(2);
  });

  it("processNextJob returns false when the queue is empty", async () => {
    expect(await processNextJob(db)).toBe(false);
  });

  it("isolates jobs between organizations", async () => {
    const a = await setup();
    const b = await setup();
    const { jobId } = await importFile(a.logist, a.templateId, THREE_ROWS);

    await expectCode(getImportJob(b.logist, jobId), "not_found");
    await expectCode(createImportJob(b.logist, { filename: "o.csv", bytes: THREE_ROWS, templateId: a.templateId }), "not_found");
    expect(await listOrders(b.logist)).toEqual([]);
  });

  it("warehouse cannot import", async () => {
    const { org, templateId } = await setup();
    await expectCode(
      createImportJob(await org.as("warehouse"), { filename: "o.csv", bytes: THREE_ROWS, templateId }),
      "forbidden",
    );
  });
});
