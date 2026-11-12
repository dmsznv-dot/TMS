import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import { recordAcceptance } from "@/server/services/acceptance";
import { recordEvent, setStopFact } from "@/server/services/execution";
import { addAccrual, addExpense, allocatePayment, createInvoice, linkExpense, listInvoices, recordPayment } from "@/server/services/finance";
import { createImportJob, enqueueImportJob, fixImportRow, listImportRows, processNextJob, saveTemplate, validateImportJob } from "@/server/import/jobs";
import { calculateRoutes, savePlan } from "@/server/services/planning";
import { createCounterparty, createLocation } from "@/server/services/refs";
import { completeTask, listTasks } from "@/server/services/tasks";
import { getTriage, type TriageKind } from "@/server/services/triage";
import { getTrip } from "@/server/services/trips";
import { makeOrg } from "../helpers/factories";
import { DEPART, makeAssignedTrip, type AssignedTrip } from "../helpers/scenarios";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

const kindsOf = async (ctx: Ctx) => (await getTriage(ctx)).map((i) => i.kind);
const has = async (ctx: Ctx, kind: TriageKind) => (await kindsOf(ctx)).includes(kind);
const rub = (n: number) => n * 100;

async function replan(t: AssignedTrip, departureAt: Date) {
  const calc = await calculateRoutes(t.logist, { tripId: t.tripId, departureAt, vehicleId: t.vehicleId, avoidToll: false });
  if (!calc.result.ok) throw new Error(calc.result.reason);
  await savePlan(t.logist, {
    tripId: t.tripId,
    expectedVersion: (await getTrip(t.logist, t.tripId)).version,
    reason: "Сдвиг выезда",
    executor: { kind: "own", vehicleId: t.vehicleId, driverId: t.driverId },
    departureAt,
    route: { kind: "sealed", token: calc.result.variants[0].token },
    toll: { kind: "none" },
    otherKop: 0,
  });
}

describe("operational items", () => {
  it("flags a plan that risks or misses a window, until the plan is moved", async () => {
    const t = await makeAssignedTrip(db, undefined, { departureAt: new Date("2026-11-12T06:40:00Z") });
    expect(await has(t.logist, "late_risk")).toBe(true);
    const item = (await getTriage(t.logist)).find((i) => i.kind === "late_risk")!;
    expect(item.title).toContain(t.trip.number);
    expect(item.href).toBe(`/trips/${t.tripId}`);

    await replan(t, DEPART);
    expect(await has(t.logist, "late_risk")).toBe(false);
  });

  it("does not flag a plan that is on time", async () => {
    const t = await makeAssignedTrip(db);
    expect(await kindsOf(t.logist)).toEqual([]);
  });

  it("flags a stop reached after its window closed, until the time is corrected", async () => {
    const t = await makeAssignedTrip(db);
    const [, a] = t.trip.stops;
    await setStopFact(t.logist, { stopId: a.id, arriveAt: new Date("2026-11-12T08:00:00Z") });
    const item = (await getTriage(t.logist)).find((i) => i.kind === "late_fact")!;
    expect(item.title).toContain("опоздание на 60 мин");

    await setStopFact(t.logist, { stopId: a.id, arriveAt: new Date("2026-11-12T06:00:00Z") });
    expect(await has(t.logist, "late_fact")).toBe(false);
  });

  it("flags an open shortage task until it is completed", async () => {
    const t = await makeAssignedTrip(db);
    await recordEvent(t.logist, { tripId: t.tripId, type: "loading_started", stopId: t.trip.stops[0].id });
    await recordAcceptance(t.logist, { tripCargoId: t.trip.stops[1].cargo[0].id, acceptedMilli: 3_000, rejectedMilli: 0, returnedMilli: 0, reasonCode: "shortage" });
    const item = (await getTriage(t.logist)).find((i) => i.kind === "partial_acceptance")!;
    expect(item.title).toContain("принято 3 из 5");
    expect(item.dueAt).toBeInstanceOf(Date);

    const [task] = await listTasks(t.logist, { tripId: t.tripId, status: "open" });
    await completeTask(t.logist, { taskId: task.id, resolution: "Доставили остаток" });
    expect(await has(t.logist, "partial_acceptance")).toBe(false);
  });

  it("flags import files with rows that were not applied, until the rows are fixed", async () => {
    const org = await makeOrg(db);
    const admin = await org.as("admin");
    const logist = await org.as("logist");
    await createLocation(logist, { name: "Магазин", externalKey: "SHOP-1", lat: 55.05, lon: 82.95, tz: "Asia/Novosibirsk", kind: "customer" });
    const { templateId } = await saveTemplate(admin, {
      name: "T",
      mapping: {
        columns: { number: "Номер", locationKey: "Точка", windowStart: "С", windowEnd: "До", qty: "Кол-во", product: "Товар" },
        dateFormat: "dd.MM.yyyy HH:mm",
        timezone: "location",
      },
    });
    const bytes = Buffer.from("Номер;Точка;С;До;Кол-во;Товар\nЗ-1;NOWHERE;12.11.2026 09:00;12.11.2026 14:00;5;Вода\n", "utf8");
    const { jobId } = await createImportJob(logist, { filename: "o.csv", bytes, templateId });
    await validateImportJob(logist, jobId);
    await enqueueImportJob(logist, jobId);
    while (await processNextJob(db)) {
      // drain
    }

    const item = (await getTriage(logist)).find((i) => i.kind === "import_errors")!;
    expect(item.href).toBe(`/import/${jobId}`);
    expect(item.title).toContain("o.csv");

    const [bad] = await listImportRows(logist, jobId, { status: "error" });
    await fixImportRow(logist, { rowId: bad.id, raw: { ...bad.raw, "Точка": "SHOP-1" } });
    expect(await has(logist, "import_errors")).toBe(false);
  });
});

describe("money items", () => {
  const TODAY = new Date("2026-11-13T09:00:00Z");

  it("flags an expense without a link until it is linked", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { expenseId } = await addExpense(finance, { category: "other", amountKop: rub(500), date: TODAY });
    expect(await has(finance, "unlinked_expense")).toBe(true);
    await linkExpense(finance, { expenseId, tripId: t.tripId });
    expect(await has(finance, "unlinked_expense")).toBe(false);
  });

  it("flags an agreed surcharge without an invoice until it is invoiced", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { id: customerId } = await createCounterparty(t.logist, { name: "ООО Ромашка", kind: "customer" });
    const { accrualId } = await addAccrual(finance, { tripId: t.tripId, kind: "surcharge", description: "Простой 3 ч", amountKop: rub(6_000), vatIncluded: false });
    const item = (await getTriage(finance)).find((i) => i.kind === "unbilled_surcharge")!;
    expect(item.title).toContain("Простой 3 ч");
    expect(item.href).toBe(`/trips/${t.tripId}?tab=money`);

    await createInvoice(finance, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "S-1", date: TODAY, dueDate: new Date("2099-01-01T00:00:00Z"), amountKop: rub(6_000), vatIncluded: false, accrualIds: [accrualId] });
    expect(await has(finance, "unbilled_surcharge")).toBe(false);
  });

  it("flags an overdue invoice until it is paid", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { id: customerId } = await createCounterparty(t.logist, { name: "ООО Ромашка", kind: "customer" });
    const { invoiceId } = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "9", date: new Date("2026-01-01T00:00:00Z"), dueDate: new Date("2026-01-15T00:00:00Z"), amountKop: rub(100), vatIncluded: true });
    const item = (await getTriage(finance)).find((i) => i.kind === "overdue_invoice")!;
    expect(item.title).toContain("№ 9");
    expect(item.href).toBe("/money");

    const { paymentId } = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(100), purpose: "счёт 9" });
    await allocatePayment(finance, { paymentId, invoiceId, amountKop: rub(100) });
    expect((await listInvoices(finance, {}))[0].state).toBe("paid");
    expect(await has(finance, "overdue_invoice")).toBe(false);
  });

  it("flags a payment that needs a review until it is allocated", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { id: customerId } = await createCounterparty(t.logist, { name: "ООО Ромашка", kind: "customer" });
    const { invoiceId } = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "1", date: TODAY, dueDate: new Date("2099-01-01T00:00:00Z"), amountKop: rub(500), vatIncluded: true });
    const { paymentId, state } = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(300), purpose: "Аванс" });
    expect(state).toBe("needs_review");
    expect(await has(finance, "payment_needs_review")).toBe(true);

    await allocatePayment(finance, { paymentId, invoiceId, amountKop: rub(300) });
    expect(await has(finance, "payment_needs_review")).toBe(false);
  });
});

describe("who sees what", () => {
  async function everything() {
    const t = await makeAssignedTrip(db, undefined, { departureAt: new Date("2026-11-12T06:40:00Z") });
    const finance = await t.org.as("finance");
    await addExpense(finance, { category: "other", amountKop: rub(500), date: new Date() });
    return { t, finance };
  }

  it("keeps money items from roles without access to money", async () => {
    const { t } = await everything();
    const warehouse = await t.org.as("warehouse");
    const kinds = await kindsOf(warehouse);
    expect(kinds).toContain("late_risk");
    expect(kinds).not.toContain("unlinked_expense");
  });

  it("shows money items to finance and the manager, but import errors only to those who import", async () => {
    const { t } = await everything();
    expect(await has(await t.org.as("manager"), "unlinked_expense")).toBe(true);
    expect(await has(await t.org.as("finance"), "unlinked_expense")).toBe(true);
    expect(await has(await t.org.as("manager"), "import_errors")).toBe(false);
  });

  it("is isolated between organizations", async () => {
    await everything();
    const other = await makeOrg(db);
    expect(await getTriage(await other.as("admin"))).toEqual([]);
  });
});
