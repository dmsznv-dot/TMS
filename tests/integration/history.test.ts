import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { recordAcceptance } from "@/server/services/acceptance";
import { recordEvent } from "@/server/services/execution";
import { addAccrual, addDocument, addExpense, createInvoice, markNotIncurred, setDocumentStatus, verifyExpense } from "@/server/services/finance";
import { listTripHistory } from "@/server/services/history";
import { closeTrip } from "@/server/services/close";
import { createShareLink, ctxFromShareToken, listShareLinks, revokeShareLink } from "@/server/services/shareLinks";
import { createCounterparty } from "@/server/services/refs";
import { getTrip } from "@/server/services/trips";
import { expectCode } from "../helpers/expectCode";
import { makeOrg } from "../helpers/factories";
import { makeAssignedTrip } from "../helpers/scenarios";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

const lines = async (ctx: Parameters<typeof listTripHistory>[0], tripId: string) => (await listTripHistory(ctx, tripId)).map((h) => h.line);

describe("trip history", () => {
  it("lists what happened to the trip, newest first, in readable words", async () => {
    const t = await makeAssignedTrip(db);
    const history = await lines(t.logist, t.tripId);
    // Oldest to newest: created, cargo added, planned (the status moves as the plan is saved), assigned.
    expect(history.slice().reverse()).toEqual([
      "Рейс создан",
      "В рейс добавлен груз",
      "Статус: Черновик → Запланирован",
      "План: версия 1, своя машина",
      "Статус: Запланирован → Назначен",
    ]);
  });

  it("shows no amounts to a role that has no access to money", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { id: customerId } = await createCounterparty(t.logist, { name: "ООО Сумма", kind: "customer" });
    await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: 1_200_000, date: new Date() });
    await addAccrual(finance, { tripId: t.tripId, kind: "revenue", description: "Доставка", amountKop: 5_000_000, vatIncluded: false });
    await createInvoice(finance, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "SUM-1", date: new Date(), dueDate: new Date(), amountKop: 5_000_000, vatIncluded: false });

    const warehouse = await t.org.as("warehouse");
    const seen = (await lines(warehouse, t.tripId)).join("\n");
    expect(seen).not.toMatch(/₽|Расход|Счёт|Начисление/);
    expect(seen).toContain("Рейс создан");
    // Finance still sees them.
    expect((await lines(finance, t.tripId)).join("\n")).toContain("12 000,00 ₽");
  });

  it("includes who did it and when", async () => {
    const t = await makeAssignedTrip(db);
    const [latest] = await listTripHistory(t.logist, t.tripId);
    expect(latest.actorName).toBe("logist");
    expect(latest.at).toBeInstanceOf(Date);
  });

  it("shows driver-link events with the driver as the actor", async () => {
    const t = await makeAssignedTrip(db);
    const { token } = await createShareLink(t.logist, { tripId: t.tripId });
    const ctx = (await ctxFromShareToken(db, token))!;
    await recordEvent(ctx, { tripId: t.tripId, type: "driver_confirmed" });
    const history = await listTripHistory(t.logist, t.tripId);
    expect(history.find((h) => h.line === "Отметка: водитель подтвердил назначение")!.actorName).toBe("Водитель по ссылке");
    expect(history.map((h) => h.line)).toContain("Создана ссылка для водителя");
  });

  it("includes money, documents, acceptance and the reason a trip was closed with missing data", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    for (const stop of t.trip.stops) {
      await recordEvent(t.logist, { tripId: t.tripId, type: stop.operation === "load" ? "loaded" : "unloaded", stopId: stop.id });
    }
    await recordAcceptance(t.logist, { tripCargoId: t.trip.stops[1].cargo[0].id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 });
    const { expenseId } = await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: 345_000, date: new Date() });
    await verifyExpense(finance, expenseId);
    await markNotIncurred(finance, { tripId: t.tripId, category: "tolls" });
    await addAccrual(finance, { tripId: t.tripId, kind: "surcharge", description: "Простой", amountKop: 600_000, vatIncluded: false });
    const { id: customerId } = await createCounterparty(t.logist, { name: "ООО Ромашка", kind: "customer" });
    await createInvoice(finance, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "15", date: new Date(), dueDate: new Date(), amountKop: 11_200_000, vatIncluded: false });
    const { documentId } = await addDocument(t.logist, { tripId: t.tripId, kind: "ТН" });
    await setDocumentStatus(finance, { documentId, status: "signed" });
    await closeTrip(finance, { tripId: t.tripId, expectedVersion: (await getTrip(finance, t.tripId)).version, overrideReason: "Сверим в конце месяца" });

    const history = await lines(finance, t.tripId);
    expect(history).toEqual(
      expect.arrayContaining([
        "Приёмка: версия 1, принято 5",
        "Расход: Топливо, 3 450,00 ₽",
        "Расход проверен",
        "Отмечено, что расхода не было: Платные дороги",
        "Начисление (доплата): 6 000,00 ₽",
        "Счёт № 15 на 112 000,00 ₽",
        "Документ: ТН",
        "Изменён статус документа",
        "Статус: Выполнен → Финансово закрыт",
      ]),
    );
    const override = history.find((l) => l.startsWith("Закрыт с исключением"))!;
    expect(override).toContain("Причина: Сверим в конце месяца");
    expect(override).toContain("Не хватало:");
  });

  it("includes revoking a link", async () => {
    const t = await makeAssignedTrip(db);
    await createShareLink(t.logist, { tripId: t.tripId });
    const [link] = await listShareLinks(t.logist, t.tripId);
    await revokeShareLink(t.logist, link.id);
    expect(await lines(t.logist, t.tripId)).toContain("Ссылка для водителя отозвана");
  });

  it("does not mix in the history of another trip", async () => {
    const a = await makeAssignedTrip(db);
    const b = await makeAssignedTrip(db, a.org);
    await recordEvent(a.logist, { tripId: a.tripId, type: "loading_started", stopId: a.trip.stops[0].id });
    expect(await lines(b.logist, b.tripId)).not.toContain("Отметка: водитель подтвердил назначение");
  });

  it("is readable by every role that sees trips, and isolated between organizations", async () => {
    const t = await makeAssignedTrip(db);
    expect((await listTripHistory(await t.org.as("warehouse"), t.tripId)).length).toBeGreaterThan(0);
    await expectCode(listTripHistory(await (await makeOrg(db)).as("logist"), t.tripId), "not_found");
  });
});
