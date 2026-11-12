import type { FieldSpec } from "@/components/EntityForm";
import type { UserCtx } from "@/server/auth/requireCtx";
import * as refs from "@/server/services/refs";

export const REF_KINDS = ["locations", "vehicles", "drivers", "counterparties"] as const;
export type RefKind = (typeof REF_KINDS)[number];

export function isRefKind(value: string): value is RefKind {
  return (REF_KINDS as readonly string[]).includes(value);
}

type Row = Record<string, unknown> & { id: string; active: boolean };

type RefConfig = {
  title: string;
  fields: FieldSpec[];
  columns: string[];
  cells(row: Row): string[];
  list(ctx: UserCtx): Promise<Row[]>;
  get(ctx: UserCtx, id: string): Promise<Row>;
  create(ctx: UserCtx, data: Record<string, unknown>): Promise<{ id: string }>;
  update(ctx: UserCtx, id: string, data: Record<string, unknown>): Promise<void>;
  setActive(ctx: UserCtx, id: string, active: boolean): Promise<void>;
  /** Fields a map click fills in, when the entity has a position. */
  map?: { latField: string; lonField: string };
};

const text = (v: unknown) => (v == null || v === "" ? "—" : String(v));

const LOCATION_KINDS = [
  { value: "warehouse", label: "Склад" },
  { value: "dc", label: "Распределительный центр" },
  { value: "customer", label: "Получатель" },
];
const COUNTERPARTY_KINDS = [
  { value: "customer", label: "Получатель" },
  { value: "carrier", label: "Перевозчик" },
];
const labelOf = (options: { value: string; label: string }[], value: unknown) =>
  options.find((o) => o.value === value)?.label ?? text(value);

// The services validate input with zod, so loosely typed form data is safe to pass through.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const REF_CONFIG: Record<RefKind, RefConfig> = {
  locations: {
    title: "Точки",
    map: { latField: "lat", lonField: "lon" },
    fields: [
      { name: "name", label: "Название", type: "text", required: true },
      { name: "kind", label: "Тип", type: "select", options: LOCATION_KINDS, required: true },
      { name: "externalKey", label: "Ключ в файлах импорта", type: "text" },
      { name: "address", label: "Адрес", type: "text" },
      { name: "lat", label: "Широта", type: "number", required: true },
      { name: "lon", label: "Долгота", type: "number", required: true },
      { name: "tz", label: "Часовой пояс", type: "text", required: true, placeholder: "Asia/Novosibirsk" },
      { name: "serviceMin", label: "Погрузка или разгрузка, мин", type: "number", required: true },
      { name: "contact", label: "Контакт", type: "text" },
      { name: "entryLat", label: "Въезд: широта", type: "number" },
      { name: "entryLon", label: "Въезд: долгота", type: "number" },
      { name: "defaultWindowStart", label: "Окно с", type: "time" },
      { name: "defaultWindowEnd", label: "Окно до", type: "time" },
      { name: "entryNotes", label: "Как заехать", type: "textarea" },
      { name: "passRules", label: "Правила пропуска", type: "textarea" },
    ],
    columns: ["Название", "Тип", "Адрес", "Координаты", "Въезд", "Окно"],
    cells: (r) => [
      text(r.name),
      labelOf(LOCATION_KINDS, r.kind),
      text(r.address),
      `${r.lat}, ${r.lon}`,
      r.entryLat != null ? `${r.entryLat}, ${r.entryLon}` : "—",
      r.defaultWindowStart || r.defaultWindowEnd
        ? `${text(r.defaultWindowStart)}–${text(r.defaultWindowEnd)}`
        : "—",
    ],
    list: (ctx) => refs.listLocations(ctx),
    get: (ctx, id) => refs.getLocation(ctx, id),
    create: (ctx, data) => refs.createLocation(ctx, data as any),
    update: (ctx, id, data) => refs.updateLocation(ctx, id, data as any),
    setActive: (ctx, id, active) => refs.setLocationActive(ctx, id, active),
  },
  vehicles: {
    title: "Машины",
    fields: [
      { name: "plate", label: "Госномер", type: "text", required: true },
      { name: "bodyType", label: "Тип кузова", type: "text" },
      { name: "capacityKg", label: "Грузоподъёмность, кг", type: "number" },
      { name: "capacityPallets", label: "Паллет", type: "number" },
      { name: "capacityM3", label: "Объём, м³", type: "number" },
      { name: "fuelNormLPer100Km", label: "Расход, л/100 км", type: "number" },
      { name: "maxPermMassT", label: "Разрешённая масса, т", type: "number" },
      { name: "massT", label: "Фактическая масса, т", type: "number" },
      { name: "axleLoadT", label: "Нагрузка на ось, т", type: "number" },
      { name: "heightM", label: "Высота, м", type: "number" },
      { name: "widthM", label: "Ширина, м", type: "number" },
      { name: "lengthM", label: "Длина, м", type: "number" },
      { name: "passIds", label: "Пропуска (идентификаторы)", type: "intlist", hint: "Через запятую" },
    ],
    columns: ["Госномер", "Кузов", "Вместимость", "Грузовой профиль", "Расход"],
    cells: (r) => [
      text(r.plate),
      text(r.bodyType),
      [r.capacityKg != null ? `${r.capacityKg} кг` : null, r.capacityPallets != null ? `${r.capacityPallets} палл.` : null]
        .filter(Boolean)
        .join(", ") || "—",
      refs.truckProfileOf(r as any).complete ? "Полный" : "Неполный",
      r.fuelNormLPer100Km != null ? `${r.fuelNormLPer100Km} л/100 км` : "—",
    ],
    list: (ctx) => refs.listVehicles(ctx),
    get: (ctx, id) => refs.getVehicle(ctx, id),
    create: (ctx, data) => refs.createVehicle(ctx, data as any),
    update: (ctx, id, data) => refs.updateVehicle(ctx, id, data as any),
    setActive: (ctx, id, active) => refs.setVehicleActive(ctx, id, active),
  },
  drivers: {
    title: "Водители",
    fields: [
      { name: "name", label: "ФИО", type: "text", required: true },
      { name: "phone", label: "Телефон", type: "text" },
    ],
    columns: ["ФИО", "Телефон"],
    cells: (r) => [text(r.name), text(r.phone)],
    list: (ctx) => refs.listDrivers(ctx),
    get: (ctx, id) => refs.getDriver(ctx, id),
    create: (ctx, data) => refs.createDriver(ctx, data as any),
    update: (ctx, id, data) => refs.updateDriver(ctx, id, data as any),
    setActive: (ctx, id, active) => refs.setDriverActive(ctx, id, active),
  },
  counterparties: {
    title: "Контрагенты",
    fields: [
      { name: "name", label: "Название", type: "text", required: true },
      { name: "kind", label: "Тип", type: "select", options: COUNTERPARTY_KINDS, required: true },
      { name: "inn", label: "ИНН", type: "text" },
      { name: "contacts", label: "Контакты", type: "text" },
      { name: "bodyTypes", label: "Типы кузова", type: "text" },
      { name: "directions", label: "Направления", type: "text" },
      { name: "vatIncluded", label: "Ставки с НДС", type: "checkbox" },
    ],
    columns: ["Название", "Тип", "ИНН", "Контакты", "НДС"],
    cells: (r) => [
      text(r.name),
      labelOf(COUNTERPARTY_KINDS, r.kind),
      text(r.inn),
      text(r.contacts),
      r.vatIncluded ? "С НДС" : "Без НДС",
    ],
    list: (ctx) => refs.listCounterparties(ctx),
    get: (ctx, id) => refs.getCounterparty(ctx, id),
    create: (ctx, data) => refs.createCounterparty(ctx, data as any),
    update: (ctx, id, data) => refs.updateCounterparty(ctx, id, data as any),
    setActive: (ctx, id, active) => refs.setCounterpartyActive(ctx, id, active),
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Defaults shown in an empty create form. */
export const REF_DEFAULTS: Partial<Record<RefKind, Record<string, unknown>>> = {
  locations: { kind: "customer", serviceMin: 30, tz: "Asia/Novosibirsk" },
  counterparties: { kind: "customer", vatIncluded: true },
};
