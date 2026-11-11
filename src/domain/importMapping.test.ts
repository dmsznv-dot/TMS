import { describe, expect, it } from "vitest";
import { mapOrderRow, type OrderMapping } from "./importMapping";

const mapping: OrderMapping = {
  columns: {
    number: "Номер заказа",
    locationKey: "Точка",
    windowStart: "Окно с",
    windowEnd: "Окно до",
    qty: "Количество",
    product: "Товар",
    unit: "Ед.",
    weightKg: "Вес, кг",
    pallets: "Паллет",
    customerName: "Получатель",
    priceRub: "Цена",
    costRub: "Себестоимость",
  },
  dateFormat: "dd.MM.yyyy HH:mm",
  timezone: "location",
};

const LOCATIONS: Record<string, { id: string; tz: string }> = {
  "RC-1": { id: "loc-1", tz: "Asia/Novosibirsk" },
};
const resolve = (key: string) => LOCATIONS[key] ?? null;

const row = (patch: Record<string, unknown> = {}) => ({
  "Номер заказа": "З-1001",
  "Точка": "RC-1",
  "Окно с": "12.11.2026 09:00",
  "Окно до": "12.11.2026 14:00",
  "Количество": "10",
  "Товар": "Вода 0,5",
  "Ед.": "палл",
  "Вес, кг": "1 234,5",
  "Паллет": "10",
  "Получатель": "ООО Ромашка",
  "Цена": "5 000,00",
  "Себестоимость": "3000",
  ...patch,
});

function errorsOf(raw: Record<string, unknown>, m: OrderMapping = mapping) {
  const result = mapOrderRow(raw, m, resolve);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("mapOrderRow", () => {
  it("maps a valid row and converts the window to UTC", () => {
    const result = mapOrderRow(row(), mapping, resolve);
    expect(result).toEqual({
      ok: true,
      value: {
        number: "З-1001",
        locationId: "loc-1",
        windowStart: new Date("2026-11-12T02:00:00.000Z"),
        windowEnd: new Date("2026-11-12T07:00:00.000Z"),
        lineKey: "Вода 0,5",
        product: "Вода 0,5",
        unit: "палл",
        qty: 10_000,
        weightKgMilli: 1_234_500,
        volumeM3Milli: null,
        palletsMilli: 10_000,
        customerName: "ООО Ромашка",
        priceKop: 500_000,
        costKop: 300_000,
      },
    });
  });

  it("reports every missing required field", () => {
    const errors = errorsOf({});
    expect(errors.map((e) => e.field).sort()).toEqual(["locationKey", "number", "qty", "windowEnd", "windowStart"]);
    expect(errors.every((e) => e.code === "required")).toBe(true);
  });

  it("reports an unknown location", () => {
    expect(errorsOf(row({ "Точка": "NOPE" }))).toEqual([
      expect.objectContaining({ field: "locationKey", code: "location_not_found" }),
    ]);
  });

  it("rejects a window that ends before it starts", () => {
    expect(errorsOf(row({ "Окно до": "12.11.2026 08:00" }))).toEqual([
      expect.objectContaining({ field: "windowEnd", code: "window_order" }),
    ]);
  });

  it("reports an unreadable date and number", () => {
    const errors = errorsOf(row({ "Окно с": "завтра утром", "Количество": "много" }));
    expect(errors.map((e) => [e.field, e.code])).toEqual([
      ["windowStart", "invalid_date"],
      ["qty", "invalid_number"],
    ]);
  });

  it("rejects a zero quantity", () => {
    expect(errorsOf(row({ "Количество": "0" }))).toEqual([
      expect.objectContaining({ field: "qty", code: "invalid_number" }),
    ]);
  });

  it("accepts numeric cells", () => {
    const result = mapOrderRow(row({ "Количество": 2.5, "Цена": 1234.5, "Номер заказа": 1001 }), mapping, resolve);
    expect(result.ok && result.value).toMatchObject({ qty: 2_500, priceKop: 123_450, number: "1001" });
  });

  it("accepts Excel date cells as wall-clock time at the point", () => {
    const result = mapOrderRow(
      row({ "Окно с": new Date(Date.UTC(2026, 10, 12, 9, 0)), "Окно до": new Date(Date.UTC(2026, 10, 12, 14, 0)) }),
      mapping,
      resolve,
    );
    expect(result.ok && result.value.windowStart.toISOString()).toBe("2026-11-12T02:00:00.000Z");
    expect(result.ok && result.value.windowEnd.toISOString()).toBe("2026-11-12T07:00:00.000Z");
  });

  it("supports the ISO-like date format", () => {
    const result = mapOrderRow(
      row({ "Окно с": "2026-11-12 09:00", "Окно до": "2026-11-12 14:00" }),
      { ...mapping, dateFormat: "yyyy-MM-dd HH:mm" },
      resolve,
    );
    expect(result.ok && result.value.windowEnd.toISOString()).toBe("2026-11-12T07:00:00.000Z");
  });

  it("uses a fixed time zone when the template names one", () => {
    const result = mapOrderRow(row(), { ...mapping, timezone: "Europe/Moscow" }, resolve);
    expect(result.ok && result.value.windowStart.toISOString()).toBe("2026-11-12T06:00:00.000Z");
  });

  it("falls back to line key 1 without a product column", () => {
    const columns = { ...mapping.columns };
    delete columns.product;
    const result = mapOrderRow(row(), { ...mapping, columns }, resolve);
    expect(result.ok && result.value).toMatchObject({ lineKey: "1", product: null });
  });

  it("prefers an explicit line key column", () => {
    const result = mapOrderRow(
      row({ "Строка": "L-7" }),
      { ...mapping, columns: { ...mapping.columns, lineKey: "Строка" } },
      resolve,
    );
    expect(result.ok && result.value.lineKey).toBe("L-7");
  });

  it("treats blank optional cells as absent", () => {
    const result = mapOrderRow(row({ "Вес, кг": "  ", "Цена": null, "Получатель": "" }), mapping, resolve);
    expect(result.ok && result.value).toMatchObject({ weightKgMilli: null, priceKop: null, customerName: null });
  });
});
