import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { deriveOrderStatus, type OrderStatus } from "@/domain/orderStatus";
import { allows, requireCan, type Ctx } from "../auth/context";
import { locations, orderLines, orders } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { parseInput } from "./validation";

const nonNegativeInt = z.number().int().nonnegative().nullish();

const lineInput = z.object({
  lineKey: z.string().trim().min(1),
  product: z.string().trim().min(1).nullish(),
  unit: z.string().trim().min(1).nullish(),
  qtyMilli: z.number().int().positive("Количество должно быть больше нуля"),
  weightKgMilli: nonNegativeInt,
  volumeM3Milli: nonNegativeInt,
  palletsMilli: nonNegativeInt,
  priceKop: nonNegativeInt,
  costKop: nonNegativeInt,
});

export const orderInput = z
  .object({
    source: z.string().trim().min(1),
    number: z.string().trim().min(1),
    customerId: z.uuid().nullish(),
    customerName: z.string().trim().min(1).nullish(),
    locationId: z.uuid(),
    windowStart: z.date(),
    windowEnd: z.date(),
    lines: z.array(lineInput).min(1, "В заказе нет строк"),
  })
  .refine((o) => o.windowEnd > o.windowStart, {
    message: "Окно заканчивается раньше, чем начинается",
    path: ["windowEnd"],
  })
  .refine((o) => new Set(o.lines.map((l) => l.lineKey)).size === o.lines.length, {
    message: "Строки заказа повторяются",
    path: ["lines"],
  });

export type OrderInput = z.input<typeof orderInput>;
export type UpsertResult = "added" | "updated" | "skipped";

export type OrderLineView = {
  id: string;
  lineKey: string;
  product: string | null;
  unit: string | null;
  qtyMilli: number;
  allocatedOpenMilli: number;
  deliveredMilli: number;
  /** Quantity that can still be put on a trip. */
  remainingMilli: number;
  weightKgMilli: number | null;
  volumeM3Milli: number | null;
  palletsMilli: number | null;
  priceKop: number | null;
  costKop: number | null;
};

export type OrderView = {
  id: string;
  number: string;
  source: string;
  customerName: string | null;
  location: { id: string; name: string; tz: string };
  windowStart: Date;
  windowEnd: Date;
  status: OrderStatus;
  createdAt: Date;
  lines: OrderLineView[];
};

export type LineProgress = { allocatedOpen: number; delivered: number };

/**
 * Planned and delivered quantities per order line. Allocation to trips and
 * acceptance are added by the trip and acceptance services.
 */
export async function lineProgress(_ctx: Ctx, lineIds: string[]): Promise<Map<string, LineProgress>> {
  return new Map(lineIds.map((id) => [id, { allocatedOpen: 0, delivered: 0 }]));
}

const LINE_FIELDS = [
  "product",
  "unit",
  "qtyMilli",
  "weightKgMilli",
  "volumeM3Milli",
  "palletsMilli",
  "priceKop",
  "costKop",
] as const;

/**
 * Creates the order or brings the stored one in line with the input.
 * Lines missing from the input stay as they are, so a file can be applied
 * row by row. An unchanged order is reported as "skipped".
 */
export async function upsertOrder(
  ctx: Ctx,
  input: OrderInput,
): Promise<{ orderId: string; result: UpsertResult; lineResults: Record<string, UpsertResult> }> {
  requireCan(ctx, "planning.write");
  const data = parseInput(orderInput, input);

  return inTransaction(ctx, async (tx) => {
    const [location] = await tx.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.id, data.locationId), eq(locations.orgId, tx.orgId)));
    if (!location) throw new DomainError("location_not_found", "Точка не найдена");

    const header = {
      customerId: data.customerId ?? null,
      customerName: data.customerName ?? null,
      locationId: data.locationId,
      windowStart: data.windowStart,
      windowEnd: data.windowEnd,
    };

    const [existing] = await tx.db
      .select()
      .from(orders)
      .where(and(eq(orders.orgId, tx.orgId), eq(orders.source, data.source), eq(orders.number, data.number)))
      .for("update");

    const lineResults: Record<string, UpsertResult> = {};

    if (!existing) {
      const [created] = await tx.db
        .insert(orders)
        .values({ orgId: tx.orgId, source: data.source, number: data.number, ...header })
        .returning({ id: orders.id });
      await tx.db.insert(orderLines).values(
        data.lines.map((l) => ({ orgId: tx.orgId, orderId: created.id, ...normalizeLine(l) })),
      );
      for (const l of data.lines) lineResults[l.lineKey] = "added";
      await audit(tx, { entity: "order", entityId: created.id, action: "create", after: { number: data.number } });
      return { orderId: created.id, result: "added" as const, lineResults };
    }

    const headerChanged =
      existing.customerId !== header.customerId ||
      existing.customerName !== header.customerName ||
      existing.locationId !== header.locationId ||
      existing.windowStart.getTime() !== header.windowStart.getTime() ||
      existing.windowEnd.getTime() !== header.windowEnd.getTime();

    const storedLines = await tx.db.select().from(orderLines).where(eq(orderLines.orderId, existing.id));
    const byKey = new Map(storedLines.map((l) => [l.lineKey, l]));
    const progress = await lineProgress(tx, storedLines.map((l) => l.id));

    for (const raw of data.lines) {
      const line = normalizeLine(raw);
      const stored = byKey.get(line.lineKey);
      if (!stored) {
        await tx.db.insert(orderLines).values({ orgId: tx.orgId, orderId: existing.id, ...line });
        lineResults[line.lineKey] = "added";
        continue;
      }
      const changed = LINE_FIELDS.some((f) => stored[f] !== line[f]);
      if (!changed) {
        lineResults[line.lineKey] = "skipped";
        continue;
      }
      const used = progress.get(stored.id) ?? { allocatedOpen: 0, delivered: 0 };
      if (line.qtyMilli < used.allocatedOpen + used.delivered) {
        throw new DomainError(
          "plan_conflict",
          "Количество меньше уже запланированного или доставленного по этой строке",
        );
      }
      await tx.db.update(orderLines).set(line).where(eq(orderLines.id, stored.id));
      lineResults[line.lineKey] = "updated";
    }

    const linesChanged = Object.values(lineResults).some((r) => r !== "skipped");
    if (headerChanged) {
      await tx.db.update(orders).set({ ...header, updatedAt: new Date() }).where(eq(orders.id, existing.id));
    }
    if (!headerChanged && !linesChanged) {
      return { orderId: existing.id, result: "skipped" as const, lineResults };
    }
    await audit(tx, {
      entity: "order",
      entityId: existing.id,
      action: "update",
      before: headerChanged ? { windowStart: existing.windowStart, windowEnd: existing.windowEnd, locationId: existing.locationId } : undefined,
      after: { header: headerChanged ? header : undefined, lines: lineResults },
    });
    return { orderId: existing.id, result: "updated" as const, lineResults };
  });
}

function normalizeLine(l: z.infer<typeof lineInput>) {
  return {
    lineKey: l.lineKey,
    product: l.product ?? null,
    unit: l.unit ?? null,
    qtyMilli: l.qtyMilli,
    weightKgMilli: l.weightKgMilli ?? null,
    volumeM3Milli: l.volumeM3Milli ?? null,
    palletsMilli: l.palletsMilli ?? null,
    priceKop: l.priceKop ?? null,
    costKop: l.costKop ?? null,
  };
}

async function loadOrders(ctx: Ctx, orderId?: string): Promise<OrderView[]> {
  const conditions = [eq(orders.orgId, ctx.orgId)];
  if (orderId) conditions.push(eq(orders.id, orderId));

  const rows = await ctx.db
    .select({ order: orders, locationName: locations.name, locationTz: locations.tz })
    .from(orders)
    .innerJoin(locations, eq(locations.id, orders.locationId))
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt), orders.number);
  if (rows.length === 0) return [];

  const lines = await ctx.db
    .select()
    .from(orderLines)
    .where(inArray(orderLines.orderId, rows.map((r) => r.order.id)))
    .orderBy(orderLines.lineKey);
  const progress = await lineProgress(ctx, lines.map((l) => l.id));
  const showMoney = allows(ctx, "money.read");

  return rows.map(({ order, locationName, locationTz }) => {
    const views: OrderLineView[] = lines
      .filter((l) => l.orderId === order.id)
      .map((l) => {
        const p = progress.get(l.id) ?? { allocatedOpen: 0, delivered: 0 };
        return {
          id: l.id,
          lineKey: l.lineKey,
          product: l.product,
          unit: l.unit,
          qtyMilli: l.qtyMilli,
          allocatedOpenMilli: p.allocatedOpen,
          deliveredMilli: p.delivered,
          remainingMilli: Math.max(0, l.qtyMilli - p.allocatedOpen - p.delivered),
          weightKgMilli: l.weightKgMilli,
          volumeM3Milli: l.volumeM3Milli,
          palletsMilli: l.palletsMilli,
          priceKop: showMoney ? l.priceKop : null,
          costKop: showMoney ? l.costKop : null,
        };
      });
    return {
      id: order.id,
      number: order.number,
      source: order.source,
      customerName: order.customerName,
      location: { id: order.locationId, name: locationName, tz: locationTz },
      windowStart: order.windowStart,
      windowEnd: order.windowEnd,
      createdAt: order.createdAt,
      status: deriveOrderStatus(
        views.map((v) => ({ qty: v.qtyMilli, allocatedOpen: v.allocatedOpenMilli, delivered: v.deliveredMilli })),
        order.cancelled,
      ),
      lines: views,
    };
  });
}

export async function listOrders(
  ctx: Ctx,
  filter: { status?: OrderStatus; search?: string } = {},
): Promise<OrderView[]> {
  requireCan(ctx, "trips.read");
  const needle = filter.search?.trim().toLowerCase();
  return (await loadOrders(ctx)).filter((o) => {
    if (filter.status && o.status !== filter.status) return false;
    if (!needle) return true;
    return (
      o.number.toLowerCase().includes(needle) ||
      (o.customerName ?? "").toLowerCase().includes(needle) ||
      o.location.name.toLowerCase().includes(needle)
    );
  });
}

export async function getOrder(ctx: Ctx, orderId: string): Promise<OrderView> {
  requireCan(ctx, "trips.read");
  const [order] = await loadOrders(ctx, orderId);
  if (!order) throw new DomainError("not_found", "Заказ не найден");
  return order;
}

export async function cancelOrder(ctx: Ctx, orderId: string): Promise<void> {
  requireCan(ctx, "planning.write");
  await inTransaction(ctx, async (tx) => {
    const order = await getOrder(tx, orderId);
    if (order.lines.some((l) => l.allocatedOpenMilli > 0)) {
      throw new DomainError("plan_conflict", "Заказ стоит в рейсе. Сначала уберите его из рейса.");
    }
    await tx.db.update(orders).set({ cancelled: true, updatedAt: new Date() }).where(eq(orders.id, orderId));
    await audit(tx, { entity: "order", entityId: orderId, action: "cancel" });
  });
}
