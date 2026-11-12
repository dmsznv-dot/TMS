import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { resetEnvCache } from "@/server/env";
import { exportDataset } from "@/server/export";
import { sealVariant } from "@/server/routing/variantToken";
import { recordAcceptance } from "@/server/services/acceptance";
import { closeTrip } from "@/server/services/close";
import { recordEvent } from "@/server/services/execution";
import { addAccrual, addExpense, createInvoice, recordPayment } from "@/server/services/finance";
import { routeBinding, savePlan } from "@/server/services/planning";
import { createCounterparty } from "@/server/services/refs";
import { getTrip } from "@/server/services/trips";
import { expectCode } from "../helpers/expectCode";
import { makeOrg } from "../helpers/factories";
import { DEPART, makeAssignedTrip } from "../helpers/scenarios";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;
const ORIGINAL = { ...process.env };

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

type Table = { headers: string[]; rows: Record<string, string>[] };

async function readXlsx(body: Buffer): Promise<Table> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const headers: string[] = [];
  ws.getRow(1).eachCell((c, i) => (headers[i - 1] = String(c.value)));
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r: Record<string, string> = {};
    headers.forEach((h, i) => {
      const v = row.getCell(i + 1).value;
      r[h] = v == null ? "" : String(v);
    });
    rows.push(r);
  });
  return { headers, rows };
}

function readCsv(body: Buffer): Table {
  const text = body.toString("utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const records = parse(text.slice(1), { delimiter: ";", skip_empty_lines: true }) as string[][];
  const [headers, ...rest] = records;
  return { headers, rows: rest.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

describe("file format", () => {
  it("gives an XLSX workbook with a dated file name", async () => {
    const t = await makeAssignedTrip(db);
    const file = await exportDataset(t.logist, "orders", "xlsx");
    expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(file.filename).toMatch(/^orders-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect((await readXlsx(file.body)).rows.length).toBe(2);
  });

  it("gives a UTF-8 CSV with a byte order mark, semicolons and a decimal comma", async () => {
    const t = await makeAssignedTrip(db);
    const file = await exportDataset(t.logist, "orders", "csv");
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    expect(file.filename).toMatch(/\.csv$/);
    const { headers, rows } = readCsv(file.body);
    expect(headers).toContain("Номер заказа");
    expect(rows[0]["Количество"]).toBe("10");
  });

  it("rejects an unknown dataset or format", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(exportDataset(t.logist, "everything" as never, "xlsx"), "validation");
    await expectCode(exportDataset(t.logist, "orders", "pdf" as never), "validation");
  });
});

describe("orders", () => {
  it("keeps the internal and external numbers, the source and the time", async () => {
    const t = await makeAssignedTrip(db);
    const { rows } = await readXlsx((await exportDataset(t.logist, "orders", "xlsx")).body);
    expect(rows[0]["Номер заказа"]).toMatch(/^З-/);
    expect(rows[0]["Источник"]).toBe("вручную");
    expect(rows[0]["Создан (UTC)"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rows[0]["Окно с (UTC)"]).toBe("2026-11-12T02:00:00.000Z");
    expect(rows[0]["В рейсах"]).toBe("5");
    expect(rows[0]["Остаток"]).toBe("5");
  });

  it("leaves prices and costs out for a role without access to money", async () => {
    const t = await makeAssignedTrip(db);
    const warehouse = await readXlsx((await exportDataset(await t.org.as("warehouse"), "orders", "xlsx")).body);
    expect(warehouse.headers.some((h) => h.includes("Цена") || h.includes("Себестоимость"))).toBe(false);
    const logist = await readXlsx((await exportDataset(t.logist, "orders", "xlsx")).body);
    expect(logist.headers.some((h) => h.includes("Цена"))).toBe(true);
  });
});

describe("trips", () => {
  it("lists the executor, plan and mileage, and says where the route figures came from", async () => {
    const t = await makeAssignedTrip(db);
    const { rows } = await readXlsx((await exportDataset(t.logist, "trips", "xlsx")).body);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      "Рейс": t.trip.number,
      "Статус": "Назначен",
      "Остановок": "3",
      "Заказов": "2",
      "Исполнитель": "А001АА154, Пётр Петров",
      "Источник расчёта": "демо-расчёт, не 2ГИС",
    });
    expect(Number(rows[0]["Расстояние по плану, км"])).toBeGreaterThan(0);
  });

  it("gives the creation and closing time of a trip, so a pilot can measure how long a trip takes", async () => {
    const t = await makeAssignedTrip(db);
    const before = (await readXlsx((await exportDataset(t.logist, "trips", "xlsx")).body)).rows[0];
    expect(before["Создан (UTC)"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(before["Закрыт (UTC)"]).toBe("");

    for (const stop of (await getTrip(t.logist, t.tripId)).stops) {
      await recordEvent(t.logist, { tripId: t.tripId, type: stop.operation === "load" ? "loaded" : "unloaded", stopId: stop.id });
    }
    const finance = await t.org.as("finance");
    await closeTrip(finance, { tripId: t.tripId, expectedVersion: (await getTrip(t.logist, t.tripId)).version, overrideReason: "Проверка выгрузки" });

    const after = (await readXlsx((await exportDataset(t.logist, "trips", "xlsx")).body)).rows[0];
    expect(after["Статус"]).toBe("Финансово закрыт");
    expect(after["Закрыт (UTC)"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  async function planWithProviderMetrics() {
    const t = await makeAssignedTrip(db);
    const token = sealVariant({ source: "2gis", distanceM: 9_000, durationS: 1_200, legDurationsS: [600, 600], legsEstimated: true, tollFiltered: false, profileComplete: true, binding: routeBinding(await getTrip(t.logist, t.tripId)) });
    await savePlan(t.logist, {
      tripId: t.tripId,
      expectedVersion: (await getTrip(t.logist, t.tripId)).version,
      reason: "Расчёт по 2ГИС",
      executor: { kind: "own", vehicleId: t.vehicleId, driverId: t.driverId },
      departureAt: DEPART,
      route: { kind: "sealed", token },
      toll: { kind: "none" },
      otherKop: 0,
    });
    return t;
  }

  it("leaves 2GIS distance and time empty unless exporting them is switched on", async () => {
    const t = await planWithProviderMetrics();
    const off = (await readXlsx((await exportDataset(t.logist, "trips", "xlsx")).body)).rows[0];
    expect(off["Источник расчёта"]).toBe("2ГИС");
    expect(off["Расстояние по плану, км"]).toBe("");
    expect(off["Время в пути по плану, мин"]).toBe("");

    process.env.EXPORT_PROVIDER_METRICS = "true";
    resetEnvCache();
    const on = (await readXlsx((await exportDataset(t.logist, "trips", "xlsx")).body)).rows[0];
    expect(on["Расстояние по плану, км"]).toBe("9");
    expect(on["Время в пути по плану, мин"]).toBe("20");
  });

  it("keeps manual and demo figures regardless of that switch", async () => {
    const t = await makeAssignedTrip(db);
    const [row] = (await readXlsx((await exportDataset(t.logist, "trips", "xlsx")).body)).rows;
    expect(row["Расстояние по плану, км"]).not.toBe("");
  });
});

describe("acceptance", () => {
  it("lists every version with the reason, the confirmation and who entered it", async () => {
    const t = await makeAssignedTrip(db);
    await recordEvent(t.logist, { tripId: t.tripId, type: "loading_started", stopId: t.trip.stops[0].id });
    const cargo = t.trip.stops[1].cargo[0];
    await recordAcceptance(t.logist, { tripCargoId: cargo.id, acceptedMilli: 3_000, rejectedMilli: 0, returnedMilli: 0, reasonCode: "shortage", confirmation: "Акт № 5" });
    await recordAcceptance(t.logist, { tripCargoId: cargo.id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 });

    const { rows } = await readXlsx((await exportDataset(t.logist, "acceptance", "xlsx")).body);
    expect(rows.map((r) => [r["Версия"], r["Принято"], r["Текущая"]])).toEqual([["2", "5", "да"], ["1", "3", "нет"]]);
    expect(rows[1]).toMatchObject({ "Рейс": t.trip.number, "Причина": "Недостача", "Подтверждение": "Акт № 5", "Внёс": "logist" });
  });
});

describe("plan and actual", () => {
  it("gives plan, actual and deviation per category with summary rows", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    await addAccrual(finance, { tripId: t.tripId, kind: "revenue", description: "Доставка", amountKop: 10_000_000, vatIncluded: false });
    await addExpense(finance, { tripId: t.tripId, category: "downtime", amountKop: 600_000, date: new Date() });

    const { rows } = await readXlsx((await exportDataset(finance, "plan_fact", "xlsx")).body);
    const byLine = Object.fromEntries(rows.map((r) => [r["Строка"], r]));
    expect(byLine["Простой"]).toMatchObject({ "План, ₽": "0", "Факт, ₽": "6000", "Отклонение, ₽": "6000" });
    expect(byLine["Выручка и доплаты"]["Факт, ₽"]).toBe("100000");
    expect(Object.keys(byLine)).toEqual(expect.arrayContaining(["Топливо", "Прямые расходы", "Маржинальный доход", "Результат после расходов парка"]));
    expect(byLine["Топливо"]["Рейс"]).toBe(t.trip.number);
    expect(byLine["Топливо"]["Факт, ₽"]).toBe("");
  });

  it("is refused for roles without access to money", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(exportDataset(await t.org.as("warehouse"), "plan_fact", "xlsx"), "forbidden");
    await expectCode(exportDataset(await t.org.as("warehouse"), "invoices_payments", "csv"), "forbidden");
    await exportDataset(await t.org.as("manager"), "plan_fact", "csv");
  });
});

describe("invoices and payments", () => {
  it("lists invoices and payments with balances", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { id: customerId } = await createCounterparty(t.logist, { name: "ООО Ромашка", kind: "customer" });
    await createInvoice(finance, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "15", date: new Date("2026-11-13T00:00:00Z"), dueDate: new Date("2026-11-30T00:00:00Z"), amountKop: 11_200_000, vatIncluded: false });
    await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: new Date("2026-11-14T00:00:00Z"), amountKop: 8_000_000, purpose: "Оплата по счёту 15" });

    const { rows } = await readXlsx((await exportDataset(finance, "invoices_payments", "xlsx")).body);
    const invoice = rows.find((r) => r["Тип"] === "Счёт")!;
    const payment = rows.find((r) => r["Тип"] === "Платёж")!;
    expect(invoice).toMatchObject({ "Номер или назначение": "15", "Контрагент": "ООО Ромашка", "Сумма, ₽": "112000", "Остаток, ₽": "112000", "Рейс": t.trip.number });
    expect(payment).toMatchObject({ "Номер или назначение": "Оплата по счёту 15", "Сумма, ₽": "80000", "Остаток, ₽": "80000", "Состояние": "Ждёт разнесения" });
  });
});

describe("isolation", () => {
  it("never includes another organization's rows", async () => {
    const a = await makeAssignedTrip(db);
    const b = await makeAssignedTrip(db);
    await recordEvent(b.logist, { tripId: b.tripId, type: "loading_started", stopId: b.trip.stops[0].id });
    await recordAcceptance(b.logist, { tripCargoId: b.trip.stops[1].cargo[0].id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 });

    // Trip numbers repeat between organizations, so look for the other side's order numbers.
    const foreign = b.trip.stops.flatMap((s) => s.cargo.map((c) => c.orderNumber));
    for (const dataset of ["orders", "acceptance"] as const) {
      const rows = (await readXlsx((await exportDataset(a.logist, dataset, "xlsx")).body)).rows;
      for (const number of foreign) expect(JSON.stringify(rows)).not.toContain(number);
    }
    expect((await readXlsx((await exportDataset(a.logist, "trips", "xlsx")).body)).rows).toHaveLength(1);
    expect((await readXlsx((await exportDataset(a.logist, "acceptance", "xlsx")).body)).rows).toHaveLength(0);

    const empty = await exportDataset(await (await makeOrg(db)).as("finance"), "plan_fact", "csv");
    expect(readCsv(empty.body).rows).toEqual([]);
  });
});
