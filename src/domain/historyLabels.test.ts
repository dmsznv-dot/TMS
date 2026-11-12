import { describe, expect, it } from "vitest";
import { describeAudit } from "./historyLabels";

const d = (entity: string, action: string, before?: unknown, after?: unknown) => describeAudit({ entity, action, before, after });

describe("describeAudit", () => {
  it("names a status change with both statuses", () => {
    expect(d("trip", "status", { status: "draft" }, { status: "planned" })).toBe("Статус: Черновик → Запланирован");
  });
  it("shows the reason of a cancellation", () => {
    expect(d("trip", "status", { status: "planned" }, { status: "cancelled", cancelReason: "Клиент отказался" })).toBe(
      "Статус: Запланирован → Отменён. Причина: Клиент отказался",
    );
  });
  it("shows the reason a trip was closed with missing data, and what was missing", () => {
    expect(d("trip", "close_override", undefined, { reason: "Сверим в конце месяца", failed: ["mileage_missing", "open_task"] })).toBe(
      "Закрыт с исключением. Причина: Сверим в конце месяца. Не хватало: пробег; открытые задачи",
    );
  });
  it("names a plan version with its reason", () => {
    expect(d("plan_version", "create", undefined, { versionNo: 2, executor: "own", reason: "Сдвиг окна" })).toBe("План: версия 2, своя машина. Причина: Сдвиг окна");
    expect(d("plan_version", "create", undefined, { versionNo: 1, executor: "carrier", reason: null })).toBe("План: версия 1, подрядчик");
  });
  it("names execution events", () => {
    expect(d("trip", "event:arrived")).toBe("Отметка: прибыл");
    expect(d("trip", "event:driver_confirmed")).toBe("Отметка: водитель подтвердил назначение");
  });
  it("names cargo, link and offer changes", () => {
    expect(d("trip", "add_cargo")).toBe("В рейс добавлен груз");
    expect(d("trip", "remove_cargo")).toBe("Из рейса убран груз");
    expect(d("trip", "reorder_stops")).toBe("Изменён порядок остановок");
    expect(d("share_link", "create")).toBe("Создана ссылка для водителя");
    expect(d("share_link", "revoke")).toBe("Ссылка для водителя отозвана");
    expect(d("carrier_offer", "status", { status: "quoted" }, { status: "confirmed" })).toBe("Предложение подрядчика: Ставка получена → Подтверждён");
  });
  it("names acceptance and money entries", () => {
    expect(d("acceptance", "record", undefined, { versionNo: 2, accepted: 5000, rejected: 0, returned: 0 })).toBe("Приёмка: версия 2, принято 5");
    expect(d("expense", "create", undefined, { category: "fuel", amountKop: 345000 })).toBe("Расход: Топливо, 3 450,00 ₽");
    expect(d("expense", "verify")).toBe("Расход проверен");
    expect(d("expense", "not_incurred", undefined, { category: "tolls" })).toBe("Отмечено, что расхода не было: Платные дороги");
    expect(d("accrual", "create", undefined, { kind: "surcharge", amountKop: 600000 })).toBe("Начисление (доплата): 6 000,00 ₽");
    expect(d("invoice", "create", undefined, { number: "15", amountKop: 11200000 })).toBe("Счёт № 15 на 112 000,00 ₽");
    expect(d("payment", "allocate", undefined, { amountKop: 8000000 })).toBe("Оплата разнесена: 80 000,00 ₽");
  });
  it("falls back to the raw names for anything it does not know", () => {
    expect(d("something", "odd")).toBe("something: odd");
  });
});
