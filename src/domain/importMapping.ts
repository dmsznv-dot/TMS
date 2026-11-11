import { parseRub } from "./money";
import { parseQty, type QtyMilli } from "./qty";
import { zonedToUtc } from "./time";

export const ORDER_FIELDS = [
  "number",
  "locationKey",
  "windowStart",
  "windowEnd",
  "qty",
  "lineKey",
  "product",
  "unit",
  "weightKg",
  "volumeM3",
  "pallets",
  "customerName",
  "priceRub",
  "costRub",
] as const;
export type OrderField = (typeof ORDER_FIELDS)[number];

export const REQUIRED_ORDER_FIELDS: OrderField[] = ["number", "locationKey", "windowStart", "windowEnd", "qty"];

export const ORDER_FIELD_LABELS: Record<OrderField, string> = {
  number: "Номер заказа",
  locationKey: "Точка (ключ или название)",
  windowStart: "Окно: начало",
  windowEnd: "Окно: конец",
  qty: "Количество",
  lineKey: "Идентификатор строки",
  product: "Товар",
  unit: "Единица измерения",
  weightKg: "Вес, кг",
  volumeM3: "Объём, м³",
  pallets: "Паллеты",
  customerName: "Получатель",
  priceRub: "Цена за единицу, ₽",
  costRub: "Себестоимость за единицу, ₽",
};

export const DATE_FORMATS = ["dd.MM.yyyy HH:mm", "yyyy-MM-dd HH:mm"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export type OrderMapping = {
  /** Field → header of the column in the file. */
  columns: Partial<Record<OrderField, string>>;
  dateFormat: DateFormat;
  /** "location": times are wall-clock at the delivery point; otherwise an IANA zone. */
  timezone: "location" | (string & {});
};

export type ParsedOrderRow = {
  number: string;
  locationId: string;
  windowStart: Date;
  windowEnd: Date;
  lineKey: string;
  product: string | null;
  unit: string | null;
  qty: QtyMilli;
  weightKgMilli: number | null;
  volumeM3Milli: number | null;
  palletsMilli: number | null;
  customerName: string | null;
  priceKop: number | null;
  costKop: number | null;
};

export type RowError = { field: OrderField | "row"; code: string; message: string };

export type MapResult = { ok: true; value: ParsedOrderRow } | { ok: false; errors: RowError[] };

const DATE_PATTERNS: Record<DateFormat, { re: RegExp; order: [number, number, number] }> = {
  // capture groups → [year, month, day]
  "dd.MM.yyyy HH:mm": { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T]+(\d{1,2}):(\d{2})(?::\d{2})?$/, order: [3, 2, 1] },
  "yyyy-MM-dd HH:mm": { re: /^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::\d{2})?$/, order: [1, 2, 3] },
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Wall-clock "YYYY-MM-DDTHH:mm" from a cell, or null when it is not a date. */
function toLocalText(value: unknown, format: DateFormat): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Spreadsheet dates carry no zone; the reader exposes their wall-clock parts as UTC.
    return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  }
  const { re, order } = DATE_PATTERNS[format];
  const match = re.exec(String(value).trim());
  if (!match) return null;
  const [year, month, day] = order.map((i) => Number(match[i]));
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  // Reject dates such as 31 February.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function toKopecks(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  }
  const kop = parseRub(String(value));
  return kop != null && kop >= 0 ? kop : null;
}

function toQty(value: unknown): number | null {
  return parseQty(typeof value === "number" ? value : String(value));
}

/**
 * Turns one row of a file into an order line using the column mapping.
 * All problems of the row are reported together.
 */
export function mapOrderRow(
  raw: Record<string, unknown>,
  mapping: OrderMapping,
  resolveLocation: (key: string) => { id: string; tz: string } | null,
): MapResult {
  const errors: RowError[] = [];
  const cell = (field: OrderField): unknown => {
    const header = mapping.columns[field];
    const value = header ? raw[header] : undefined;
    return isBlank(value) ? undefined : value;
  };
  const required = (field: OrderField): unknown => {
    const value = cell(field);
    if (value === undefined) {
      errors.push({ field, code: "required", message: `Не заполнено поле «${ORDER_FIELD_LABELS[field]}»` });
    }
    return value;
  };
  const text = (field: OrderField): string | null => {
    const value = cell(field);
    return value === undefined ? null : String(value).trim();
  };

  const numberCell = required("number");

  const locationCell = required("locationKey");
  let location: { id: string; tz: string } | null = null;
  if (locationCell !== undefined) {
    location = resolveLocation(String(locationCell).trim());
    if (!location) {
      errors.push({
        field: "locationKey",
        code: "location_not_found",
        message: `Точка «${String(locationCell).trim()}» не найдена в справочнике`,
      });
    }
  }

  const tz = mapping.timezone === "location" ? location?.tz : mapping.timezone;
  const windowCells = { windowStart: required("windowStart"), windowEnd: required("windowEnd") };
  const window: { windowStart?: Date; windowEnd?: Date } = {};
  if (tz) {
    for (const field of ["windowStart", "windowEnd"] as const) {
      const value = windowCells[field];
      if (value === undefined) continue;
      const local = toLocalText(value, mapping.dateFormat);
      if (!local) {
        errors.push({
          field,
          code: "invalid_date",
          message: `Дата «${String(value)}» не соответствует формату ${mapping.dateFormat}`,
        });
        continue;
      }
      window[field] = zonedToUtc(local, tz);
    }
    if (window.windowStart && window.windowEnd && window.windowEnd <= window.windowStart) {
      errors.push({ field: "windowEnd", code: "window_order", message: "Окно заканчивается раньше, чем начинается" });
    }
  }

  const qtyCell = required("qty");
  let qty: number | null = null;
  if (qtyCell !== undefined) {
    qty = toQty(qtyCell);
    if (qty == null || qty <= 0) {
      qty = null;
      errors.push({ field: "qty", code: "invalid_number", message: `Количество «${String(qtyCell)}» не является положительным числом` });
    }
  }

  const optionalNumber = (field: OrderField, parse: (v: unknown) => number | null): number | null => {
    const value = cell(field);
    if (value === undefined) return null;
    const parsed = parse(value);
    if (parsed == null) {
      errors.push({
        field,
        code: "invalid_number",
        message: `Значение «${String(value)}» в поле «${ORDER_FIELD_LABELS[field]}» не является числом`,
      });
    }
    return parsed;
  };

  const weightKgMilli = optionalNumber("weightKg", toQty);
  const volumeM3Milli = optionalNumber("volumeM3", toQty);
  const palletsMilli = optionalNumber("pallets", toQty);
  const priceKop = optionalNumber("priceRub", toKopecks);
  const costKop = optionalNumber("costRub", toKopecks);

  if (errors.length > 0 || !location || !window.windowStart || !window.windowEnd || qty == null) {
    return { ok: false, errors };
  }

  const product = text("product");
  return {
    ok: true,
    value: {
      number: String(numberCell).trim(),
      locationId: location.id,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      lineKey: text("lineKey") ?? product ?? "1",
      product,
      unit: text("unit"),
      qty,
      weightKgMilli,
      volumeM3Milli,
      palletsMilli,
      customerName: text("customerName"),
      priceKop,
      costKop,
    },
  };
}
