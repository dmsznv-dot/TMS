import { and, asc, desc, eq, sql } from "drizzle-orm";
import { EXPENSE_LABELS } from "@/domain/costEstimate";
import { ORDER_STATUS_LABELS } from "@/domain/orderStatus";
import { TRIP_STATUS_LABELS } from "@/domain/tripStatus";
import { allows, requireCan, type Ctx } from "../auth/context";
import {
  acceptances,
  carrierOffers,
  counterparties,
  drivers,
  locations,
  orderLines,
  orders,
  planVersions,
  tripCargo,
  tripStops,
  trips,
  users,
  vehicles,
} from "../db/schema";
import { env } from "../env";
import { REASON_LABELS } from "../services/acceptance";
import { getTripEconomics } from "../services/economics";
import { listInvoices, listPayments } from "../services/finance";
import { listOrders } from "../services/orders";

export const DATASETS = ["orders", "trips", "acceptance", "plan_fact", "invoices_payments"] as const;
export type Dataset = (typeof DATASETS)[number];

export const DATASET_LABELS: Record<Dataset, string> = {
  orders: "Заказы",
  trips: "Рейсы",
  acceptance: "Приёмка",
  plan_fact: "План и факт по рейсам",
  invoices_payments: "Счета и оплаты",
};

export type Cell = string | number | null;
/** text; number as it is; money in rubles; datetime as ISO 8601 in UTC. */
export type Column = { key: string; header: string; kind: "text" | "number" | "money" | "datetime" };
export type Table = { columns: Column[]; rows: Record<string, Cell>[] };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const rubles = (kop: number | null) => (kop === null ? null : kop / 100);
const milli = (n: number | null) => (n === null ? null : n / 1000);

const SOURCE_LABELS = { "2gis": "2ГИС", synthetic: "демо-расчёт, не 2ГИС", manual: "ручная оценка" } as const;

function orderSource(source: string): string {
  if (source === "manual") return "вручную";
  if (source.startsWith("template:")) return "файл импорта";
  return source;
}

async function ordersTable(ctx: Ctx): Promise<Table> {
  const money = allows(ctx, "money.read");
  const columns: Column[] = [
    { key: "number", header: "Номер заказа", kind: "text" },
    { key: "source", header: "Источник", kind: "text" },
    { key: "customer", header: "Получатель", kind: "text" },
    { key: "location", header: "Точка", kind: "text" },
    { key: "windowStart", header: "Окно с (UTC)", kind: "datetime" },
    { key: "windowEnd", header: "Окно до (UTC)", kind: "datetime" },
    { key: "status", header: "Статус", kind: "text" },
    { key: "lineKey", header: "Строка", kind: "text" },
    { key: "product", header: "Товар", kind: "text" },
    { key: "unit", header: "Ед.", kind: "text" },
    { key: "qty", header: "Количество", kind: "number" },
    { key: "delivered", header: "Принято", kind: "number" },
    { key: "planned", header: "В рейсах", kind: "number" },
    { key: "remaining", header: "Остаток", kind: "number" },
    ...(money
      ? ([
          { key: "price", header: "Цена за единицу, ₽", kind: "money" },
          { key: "cost", header: "Себестоимость за единицу, ₽", kind: "money" },
        ] as Column[])
      : []),
    { key: "createdAt", header: "Создан (UTC)", kind: "datetime" },
  ];
  const rows: Table["rows"] = [];
  for (const o of await listOrders(ctx)) {
    for (const l of o.lines) {
      rows.push({
        number: o.number,
        source: orderSource(o.source),
        customer: o.customerName,
        location: o.location.name,
        windowStart: iso(o.windowStart),
        windowEnd: iso(o.windowEnd),
        status: ORDER_STATUS_LABELS[o.status],
        lineKey: l.lineKey,
        product: l.product,
        unit: l.unit,
        qty: milli(l.qtyMilli),
        delivered: milli(l.deliveredMilli),
        planned: milli(l.allocatedOpenMilli),
        remaining: milli(l.remainingMilli),
        price: rubles(l.priceKop),
        cost: rubles(l.costKop),
        createdAt: iso(o.createdAt),
      });
    }
  }
  return { columns, rows };
}

async function tripsTable(ctx: Ctx): Promise<Table> {
  const columns: Column[] = [
    { key: "number", header: "Рейс", kind: "text" },
    { key: "status", header: "Статус", kind: "text" },
    { key: "createdAt", header: "Создан (UTC)", kind: "datetime" },
    { key: "closedAt", header: "Закрыт (UTC)", kind: "datetime" },
    { key: "stops", header: "Остановок", kind: "number" },
    { key: "orders", header: "Заказов", kind: "number" },
    { key: "executor", header: "Исполнитель", kind: "text" },
    { key: "departure", header: "Выезд по плану (UTC)", kind: "datetime" },
    { key: "distance", header: "Расстояние по плану, км", kind: "number" },
    { key: "duration", header: "Время в пути по плану, мин", kind: "number" },
    { key: "metricsSource", header: "Источник расчёта", kind: "text" },
    { key: "mileage", header: "Пробег по факту, км", kind: "number" },
    { key: "cancelReason", header: "Причина отмены", kind: "text" },
  ];

  const rows = await ctx.db
    .select({
      trip: trips,
      plan: planVersions,
      plate: vehicles.plate,
      driver: drivers.name,
      carrier: counterparties.name,
      stops: sql<number>`(select count(*)::int from trip_stop where trip_stop.trip_id = ${trips.id})`,
      orderCount: sql<number>`(select count(distinct ol.order_id)::int from trip_cargo tc join order_line ol on ol.id = tc.order_line_id where tc.trip_id = ${trips.id})`,
    })
    .from(trips)
    .leftJoin(planVersions, and(eq(planVersions.tripId, trips.id), eq(planVersions.isCurrent, true)))
    .leftJoin(vehicles, eq(vehicles.id, planVersions.vehicleId))
    .leftJoin(drivers, eq(drivers.id, planVersions.driverId))
    .leftJoin(carrierOffers, eq(carrierOffers.id, planVersions.carrierOfferId))
    .leftJoin(counterparties, eq(counterparties.id, carrierOffers.carrierId))
    .where(eq(trips.orgId, ctx.orgId))
    .orderBy(asc(trips.number));

  const providerAllowed = env.EXPORT_PROVIDER_METRICS;
  return {
    columns,
    rows: rows.map(({ trip, plan, plate, driver, carrier, stops, orderCount }) => {
      const fromProvider = plan?.metricsSource === "2gis" && !providerAllowed;
      return {
        number: trip.number,
        status: TRIP_STATUS_LABELS[trip.status],
        createdAt: iso(trip.createdAt),
        closedAt: iso(trip.closedAt),
        stops,
        orders: orderCount,
        executor: !plan ? null : plan.executor === "own" ? [plate, driver].filter(Boolean).join(", ") : carrier,
        departure: iso(plan?.departureAt),
        distance: plan && !fromProvider ? Math.round(plan.distanceM / 100) / 10 : null,
        duration: plan && !fromProvider ? Math.round(plan.durationS / 60) : null,
        metricsSource: plan ? SOURCE_LABELS[plan.metricsSource] : null,
        mileage: trip.mileageUnknown ? null : trip.mileageKm,
        cancelReason: trip.cancelReason,
      };
    }),
  };
}

async function acceptanceTable(ctx: Ctx): Promise<Table> {
  const columns: Column[] = [
    { key: "trip", header: "Рейс", kind: "text" },
    { key: "order", header: "Заказ", kind: "text" },
    { key: "source", header: "Источник заказа", kind: "text" },
    { key: "product", header: "Товар", kind: "text" },
    { key: "stop", header: "Точка разгрузки", kind: "text" },
    { key: "loaded", header: "Погружено", kind: "number" },
    { key: "accepted", header: "Принято", kind: "number" },
    { key: "rejected", header: "Отклонено", kind: "number" },
    { key: "returned", header: "Возвращено", kind: "number" },
    { key: "reason", header: "Причина", kind: "text" },
    { key: "version", header: "Версия", kind: "number" },
    { key: "current", header: "Текущая", kind: "text" },
    { key: "confirmation", header: "Подтверждение", kind: "text" },
    { key: "at", header: "Внесено (UTC)", kind: "datetime" },
    { key: "by", header: "Внёс", kind: "text" },
  ];
  const rows = await ctx.db
    .select({ a: acceptances, cargo: tripCargo, tripNumber: trips.number, orderNumber: orders.number, source: orders.source, product: orderLines.product, stop: locations.name, by: users.name })
    .from(acceptances)
    .innerJoin(tripCargo, eq(tripCargo.id, acceptances.tripCargoId))
    .innerJoin(trips, eq(trips.id, tripCargo.tripId))
    .innerJoin(orderLines, eq(orderLines.id, tripCargo.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(tripStops, eq(tripStops.id, tripCargo.stopId))
    .innerJoin(locations, eq(locations.id, tripStops.locationId))
    .innerJoin(users, eq(users.id, acceptances.createdBy))
    .where(eq(acceptances.orgId, ctx.orgId))
    .orderBy(asc(trips.number), asc(orders.number), desc(acceptances.versionNo));
  return {
    columns,
    rows: rows.map(({ a, cargo, tripNumber, orderNumber, source, product, stop, by }) => ({
      trip: tripNumber,
      order: orderNumber,
      source: orderSource(source),
      product,
      stop,
      loaded: milli(cargo.loadedMilli ?? cargo.qtyMilli),
      accepted: milli(a.acceptedMilli),
      rejected: milli(a.rejectedMilli),
      returned: milli(a.returnedMilli),
      reason: a.reasonCode ? REASON_LABELS[a.reasonCode] : null,
      version: a.versionNo,
      current: a.isCurrent ? "да" : "нет",
      confirmation: a.confirmation,
      at: iso(a.createdAt),
      by,
    })),
  };
}

async function planFactTable(ctx: Ctx): Promise<Table> {
  requireCan(ctx, "money.read");
  const columns: Column[] = [
    { key: "trip", header: "Рейс", kind: "text" },
    { key: "status", header: "Статус рейса", kind: "text" },
    { key: "line", header: "Строка", kind: "text" },
    { key: "plan", header: "План, ₽", kind: "money" },
    { key: "fact", header: "Факт, ₽", kind: "money" },
    { key: "deviation", header: "Отклонение, ₽", kind: "money" },
    { key: "basis", header: "Основа плана", kind: "text" },
    { key: "expenses", header: "Расходов в факте", kind: "number" },
    { key: "unverified", header: "Из них не проверено", kind: "number" },
  ];
  const rows: Table["rows"] = [];
  const list = await ctx.db.select({ id: trips.id, number: trips.number, status: trips.status }).from(trips).where(eq(trips.orgId, ctx.orgId)).orderBy(asc(trips.number)).limit(500);
  for (const t of list) {
    const e = await getTripEconomics(ctx, t.id);
    const basis = e.basis === "baseline" ? "план на момент назначения" : e.basis === "current" ? "текущий план" : "плана нет";
    const common = { trip: t.number, status: TRIP_STATUS_LABELS[t.status], basis, expenses: e.expenses.length, unverified: e.expenses.filter((x) => x.checkStatus === "unverified").length };
    const dev = (d: number | null | undefined) => (d == null ? null : d / 100);
    for (const c of e.categories) {
      const delta = e.deviation.find((d) => d.category === c.category)?.kop ?? (c.factKop !== null && c.planKop !== null ? 0 : null);
      rows.push({ ...common, line: EXPENSE_LABELS[c.category], plan: rubles(c.planKop), fact: rubles(c.factKop), deviation: dev(delta) });
    }
    const { plan, fact } = e.result;
    const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : (b - a) / 100);
    rows.push({ ...common, line: "Прямые расходы", plan: rubles(plan.directKop), fact: rubles(fact.directKop), deviation: dev(e.result.deviationTotalKop) });
    rows.push({ ...common, line: "Выручка и доплаты", plan: rubles(e.revenueKop), fact: rubles(e.revenueKop === null ? null : e.revenueKop + e.surchargesKop), deviation: dev(e.revenueKop === null ? null : e.surchargesKop) });
    rows.push({ ...common, line: "Маржинальный доход", plan: rubles(plan.marginKop), fact: rubles(fact.marginKop), deviation: diff(plan.marginKop, fact.marginKop) });
    rows.push({ ...common, line: "Расходы парка", plan: rubles(e.fleet.plan), fact: rubles(e.fleet.fact), deviation: null });
    rows.push({ ...common, line: "Результат после расходов парка", plan: rubles(plan.afterFleetKop), fact: rubles(fact.afterFleetKop), deviation: diff(plan.afterFleetKop, fact.afterFleetKop) });
  }
  return { columns, rows };
}

const PAYMENT_STATES = {
  unallocated: "Ждёт разнесения",
  needs_review: "Требует проверки",
  partially_allocated: "Разнесён частично",
  allocated: "Разнесён полностью",
} as const;
const INVOICE_STATES = { unpaid: "Не оплачен", partially_paid: "Оплачен частично", paid: "Оплачен" } as const;

async function invoicesPaymentsTable(ctx: Ctx): Promise<Table> {
  requireCan(ctx, "money.read");
  const columns: Column[] = [
    { key: "type", header: "Тип", kind: "text" },
    { key: "ref", header: "Номер или назначение", kind: "text" },
    { key: "counterparty", header: "Контрагент", kind: "text" },
    { key: "direction", header: "Направление", kind: "text" },
    { key: "date", header: "Дата (UTC)", kind: "datetime" },
    { key: "due", header: "Срок (UTC)", kind: "datetime" },
    { key: "amount", header: "Сумма, ₽", kind: "money" },
    { key: "paid", header: "Оплачено или разнесено, ₽", kind: "money" },
    { key: "remaining", header: "Остаток, ₽", kind: "money" },
    { key: "state", header: "Состояние", kind: "text" },
    { key: "trip", header: "Рейс", kind: "text" },
  ];
  const tripNumbers = new Map((await ctx.db.select({ id: trips.id, number: trips.number }).from(trips).where(eq(trips.orgId, ctx.orgId))).map((t) => [t.id, t.number]));
  const rows: Table["rows"] = [];
  for (const i of await listInvoices(ctx)) {
    rows.push({
      type: "Счёт",
      ref: i.number,
      counterparty: i.counterpartyName,
      direction: i.direction === "out" ? "Выставлен клиенту" : "Получен от перевозчика",
      date: iso(i.date),
      due: iso(i.dueDate),
      amount: rubles(i.amountKop),
      paid: rubles(i.paidKop),
      remaining: rubles(i.remainingKop),
      state: i.overdue ? "Просрочен" : INVOICE_STATES[i.state],
      trip: i.tripId ? (tripNumbers.get(i.tripId) ?? null) : null,
    });
  }
  for (const p of await listPayments(ctx)) {
    rows.push({
      type: "Платёж",
      ref: p.purpose,
      counterparty: p.counterpartyName,
      direction: p.direction === "in" ? "Поступление" : "Списание",
      date: iso(p.date),
      due: null,
      amount: rubles(p.amountKop),
      paid: rubles(p.allocatedKop),
      remaining: rubles(p.remainingKop),
      state: PAYMENT_STATES[p.state],
      trip: null,
    });
  }
  return { columns, rows };
}

/** The rows of a dataset as the role of the context may see them. */
export async function buildDataset(ctx: Ctx, dataset: Dataset): Promise<Table> {
  switch (dataset) {
    case "orders":
      return ordersTable(ctx);
    case "trips":
      return tripsTable(ctx);
    case "acceptance":
      return acceptanceTable(ctx);
    case "plan_fact":
      return planFactTable(ctx);
    case "invoices_payments":
      return invoicesPaymentsTable(ctx);
  }
}
