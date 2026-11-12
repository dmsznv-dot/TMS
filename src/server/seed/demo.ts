import { eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { OrderMapping } from "@/domain/importMapping";
import type { Ctx } from "../auth/context";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { env } from "../env";
import { saveTemplate } from "../import/jobs";
import { createCounterparty, createDriver, createLocation, createVehicle } from "../services/refs";
import { createOrganization, createUser } from "../services/users";

export const DEMO_ORG_NAME = "Демо-поставщик";

const FULL_PROFILE = { maxPermMassT: 12, massT: 9, axleLoadT: 6, heightM: 3.4, widthM: 2.5, lengthM: 8.2 };

/** Headers of the demo orders file, and the template that reads them. */
export const DEMO_HEADERS = [
  "Номер заказа",
  "Получатель",
  "Точка",
  "Окно с",
  "Окно до",
  "Товар",
  "Ед.",
  "Количество",
  "Вес, кг",
  "Паллет",
  "Цена",
  "Себестоимость",
] as const;

export const DEMO_MAPPING: OrderMapping = {
  columns: {
    number: "Номер заказа",
    customerName: "Получатель",
    locationKey: "Точка",
    windowStart: "Окно с",
    windowEnd: "Окно до",
    product: "Товар",
    unit: "Ед.",
    qty: "Количество",
    weightKg: "Вес, кг",
    pallets: "Паллет",
    priceRub: "Цена",
    costRub: "Себестоимость",
  },
  dateFormat: "dd.MM.yyyy HH:mm",
  timezone: "location",
};

type Row = [string, string, string, string, string, string, string, number, number, number, number, number];

/** Seven orders for the next two days; the last one names a point that does not exist. */
const DEMO_ROWS: Row[] = [
  ["З-3001", "ООО Ромашка", "SHOP-1", "12.11.2026 09:00", "12.11.2026 14:00", "Вода 0,5 л", "палл", 10, 4500, 10, 52000, 41000],
  ["З-3001", "ООО Ромашка", "SHOP-1", "12.11.2026 09:00", "12.11.2026 14:00", "Сок 1 л", "палл", 4, 2000, 4, 78000, 60000],
  ["З-3002", "ИП Василёк", "SHOP-2", "12.11.2026 10:00", "12.11.2026 16:00", "Вода 0,5 л", "палл", 6, 2700, 6, 52000, 41000],
  ["З-3003", "Сеть «Продукты у дома»", "RC-1", "12.11.2026 08:00", "12.11.2026 14:00", "Вода 0,5 л", "палл", 12, 5400, 12, 50000, 41000],
  ["З-3003", "Сеть «Продукты у дома»", "RC-1", "12.11.2026 08:00", "12.11.2026 14:00", "Молоко 1 л", "палл", 8, 4200, 8, 91000, 76000],
  ["З-3004", "ООО Колос", "SHOP-3", "13.11.2026 09:00", "13.11.2026 15:00", "Сок 1 л", "палл", 8, 4000, 8, 78000, 60000],
  ["З-3005", "ООО Север", "SHOP-4", "13.11.2026 09:00", "13.11.2026 15:00", "Вода 0,5 л", "палл", 5, 2250, 5, 52000, 41000],
  ["З-3006", "ООО Кольцово", "SHOP-5", "13.11.2026 11:00", "13.11.2026 17:00", "Молоко 1 л", "палл", 6, 3150, 6, 91000, 76000],
  ["З-3007", "ООО Заречье", "SHOP-9", "13.11.2026 09:00", "13.11.2026 15:00", "Вода 0,5 л", "палл", 5, 2250, 5, 52000, 41000],
];

/** The demo file as XLSX. The row with point SHOP-9 is wrong on purpose: it shows how errors are reported. */
export async function buildDemoOrdersXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Заказы");
  sheet.addRow([...DEMO_HEADERS]);
  for (const row of DEMO_ROWS) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((c) => (c.width = 16));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const TZ = "Asia/Novosibirsk";

/**
 * Creates a demo organization with five users (one per role), a warehouse, a
 * distribution center with its own gate, five shops in Novosibirsk, three
 * trucks, drivers, carriers, customers and an import template. Running it
 * again changes nothing. Every pair of points is closer than 50 km, the limit
 * of a 2GIS demo key.
 */
export async function seedDemo(db: Db, opts: { password?: string } = {}): Promise<{ orgId: string }> {
  const password = opts.password ?? env.SEED_PASSWORD;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tms-seed-demo'))`);
    const [existing] = await tx.select({ orgId: users.orgId }).from(users).where(eq(users.email, "admin@demo.local"));
    if (existing) return { orgId: existing.orgId };

    const { orgId, userId } = await createOrganization(tx, {
      orgName: DEMO_ORG_NAME,
      adminEmail: "admin@demo.local",
      adminPassword: password,
      adminName: "Администратор",
    });
    const ctx: Ctx = { db: tx, orgId, actor: { kind: "user", userId, role: "admin" } };

    for (const [role, name] of [
      ["logist", "Логист"],
      ["warehouse", "Склад"],
      ["finance", "Финансы"],
      ["manager", "Руководитель"],
    ] as const) {
      await createUser(ctx, { email: `${role}@demo.local`, name, role, password });
    }

    const points = [
      { name: "Склад на Станционной", externalKey: "WH-1", kind: "warehouse", lat: 54.9925, lon: 82.8285, address: "Новосибирск, ул. Станционная, 30", serviceMin: 40 },
      {
        name: "РЦ «Продукты у дома»",
        externalKey: "RC-1",
        kind: "dc",
        lat: 55.0585,
        lon: 83.0252,
        address: "Новосибирск, ул. Электрозаводская, 2",
        entryLat: 55.0597,
        entryLon: 83.0231,
        entryNotes: "Въезд с северной стороны, ворота 4",
        passRules: "Пропуск на машину оформляется за сутки",
        contact: "Диспетчер РЦ, +7 383 000-00-04",
        serviceMin: 60,
        defaultWindowStart: "08:00",
        defaultWindowEnd: "14:00",
      },
      { name: "Магазин на Красном проспекте", externalKey: "SHOP-1", kind: "customer", lat: 55.0415, lon: 82.9146, address: "Новосибирск, Красный проспект, 25" },
      { name: "Магазин в Академгородке", externalKey: "SHOP-2", kind: "customer", lat: 54.8441, lon: 83.0921, address: "Новосибирск, ул. Золотодолинская, 11" },
      { name: "Магазин на Затулинке", externalKey: "SHOP-3", kind: "customer", lat: 54.9472, lon: 82.9033, address: "Новосибирск, ул. Одоевского, 5" },
      { name: "Магазин на Ленинском", externalKey: "SHOP-4", kind: "customer", lat: 54.989, lon: 82.94, address: "Новосибирск, ул. Ленина, 40" },
      { name: "Магазин в Кольцово", externalKey: "SHOP-5", kind: "customer", lat: 54.9362, lon: 83.1855, address: "Кольцово, ул. Технопарковая, 3" },
    ] as const;
    for (const point of points) await createLocation(ctx, { tz: TZ, ...point });

    await createVehicle(ctx, { plate: "А777АА154", bodyType: "Тент", capacityPallets: 20, capacityKg: 10_000, fuelNormLPer100Km: 25, ...FULL_PROFILE });
    await createVehicle(ctx, { plate: "В123ТТ154", bodyType: "Рефрижератор", capacityPallets: 12, capacityKg: 7_000, fuelNormLPer100Km: 28, ...FULL_PROFILE });
    // The profile of this one is incomplete on purpose: the plan shows a warning for it.
    await createVehicle(ctx, { plate: "К456НН54", bodyType: "Фургон", capacityPallets: 6, capacityKg: 1_500, fuelNormLPer100Km: 14, maxPermMassT: 3.5, widthM: 2 });

    await createDriver(ctx, { name: "Пётр Петров", phone: "+7 900 111-22-33" });
    await createDriver(ctx, { name: "Иван Сидоров", phone: "+7 900 222-33-44" });
    await createDriver(ctx, { name: "Сергей Козлов", phone: "+7 900 333-44-55" });

    await createCounterparty(ctx, { name: "ООО Ромашка", kind: "customer", inn: "5400000001" });
    await createCounterparty(ctx, { name: "Сеть «Продукты у дома»", kind: "customer", inn: "5400000002" });
    await createCounterparty(ctx, { name: "ИП Перевозов", kind: "carrier", bodyTypes: "Тент, рефрижератор", directions: "Новосибирск и область", vatIncluded: false });
    await createCounterparty(ctx, { name: "ООО ТрансЛайн", kind: "carrier", bodyTypes: "Тент", directions: "Сибирь", vatIncluded: true });

    await saveTemplate(ctx, { name: "Демо", mapping: DEMO_MAPPING });
    return { orgId };
  });
}
