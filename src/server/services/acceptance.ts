import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { formatQty } from "@/domain/qty";
import { requireCan, type Ctx } from "../auth/context";
import {
  acceptances,
  orderLines,
  orders,
  tasks,
  tripCargo,
  trips,
  tripStops,
  users,
  type ReasonCode,
  type TaskType,
} from "../db/schema";
import { audit, inTransaction } from "./audit";
import { lockTrip } from "./trips";
import { parseInput } from "./validation";

const REASONS = ["shortage", "damage", "quality", "docs_mismatch", "refused", "other"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCEPTING = ["in_progress", "completed"];

const qty = z.number().int().nonnegative("Количество не может быть отрицательным");

export const acceptanceInput = z.object({
  tripCargoId: z.uuid(),
  acceptedMilli: qty,
  rejectedMilli: qty,
  returnedMilli: qty,
  reasonCode: z.enum(REASONS).optional(),
  confirmation: z.string().trim().min(1).optional(),
  responsibleUserId: z.uuid().optional(),
  dueAt: z.date().optional(),
});

/**
 * Records what the recipient accepted of a cargo row. A correction is saved
 * as a new version and the earlier one stays. Accepting less than was
 * loaded needs a reason and raises a task with an owner and a due date.
 */
export async function recordAcceptance(
  ctx: Ctx,
  input: z.input<typeof acceptanceInput>,
): Promise<{ versionNo: number; taskId: string | null }> {
  const actor = requireCan(ctx, "execution.write");
  const data = parseInput(acceptanceInput, input);

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select({ cargo: tripCargo, orderId: orders.id, orderNumber: orders.number })
      .from(tripCargo)
      .innerJoin(orderLines, eq(orderLines.id, tripCargo.orderLineId))
      .innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(and(eq(tripCargo.id, data.tripCargoId), eq(tripCargo.orgId, tx.orgId)));
    if (!row) throw new DomainError("not_found", "Груз не найден");
    const { cargo } = row;

    const trip = await lockTrip(tx, cargo.tripId, undefined, null);
    if (!ACCEPTING.includes(trip.status)) {
      throw new DomainError("trip_not_active", "Приёмку вносят после выезда рейса, до финансового закрытия");
    }

    const base = cargo.loadedMilli ?? cargo.qtyMilli;
    if (data.acceptedMilli + data.rejectedMilli + data.returnedMilli > base) {
      throw new DomainError(
        "exceeds_loaded",
        `Принято, отклонено и возвращено вместе больше ${cargo.loadedMilli == null ? "запланированного" : "погруженного"} количества (${formatQty(base)})`,
      );
    }
    const shortfall = data.acceptedMilli < base;
    if (shortfall && !data.reasonCode) {
      throw new DomainError("reason_required", "Принято меньше, чем отгружено: укажите причину");
    }

    let responsibleId = actor.userId;
    if (data.responsibleUserId) {
      const [user] = await tx.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, data.responsibleUserId), eq(users.orgId, tx.orgId), eq(users.active, true)));
      if (!user) throw new DomainError("not_found", "Ответственный не найден");
      responsibleId = user.id;
    }

    const [previous] = await tx.db
      .select()
      .from(acceptances)
      .where(eq(acceptances.tripCargoId, cargo.id))
      .orderBy(desc(acceptances.versionNo))
      .limit(1);
    if (previous) await tx.db.update(acceptances).set({ isCurrent: false }).where(eq(acceptances.id, previous.id));
    const versionNo = (previous?.versionNo ?? 0) + 1;

    await tx.db.insert(acceptances).values({
      orgId: tx.orgId,
      tripCargoId: cargo.id,
      versionNo,
      isCurrent: true,
      acceptedMilli: data.acceptedMilli,
      rejectedMilli: data.rejectedMilli,
      returnedMilli: data.returnedMilli,
      reasonCode: (data.reasonCode ?? null) as ReasonCode | null,
      confirmation: data.confirmation ?? null,
      createdBy: actor.userId,
    });

    // The new version replaces whatever the earlier one raised.
    await tx.db
      .update(tasks)
      .set({ status: "done", resolution: "Заменена новой версией приёмки", completedAt: new Date() })
      .where(and(eq(tasks.tripCargoId, cargo.id), eq(tasks.status, "open"), inArray(tasks.type, ["shortfall", "rejection", "return"])));

    let taskId: string | null = null;
    if (shortfall) {
      const type: TaskType = data.returnedMilli > 0 ? "return" : data.rejectedMilli > 0 ? "rejection" : "shortfall";
      const head = { shortfall: "Недопоставка", rejection: "Отказ", return: "Возврат" }[type as "shortfall" | "rejection" | "return"];
      const detail =
        type === "return"
          ? `возвращено ${formatQty(data.returnedMilli)}`
          : type === "rejection"
            ? `отклонено ${formatQty(data.rejectedMilli)}`
            : "";
      const [task] = await tx.db
        .insert(tasks)
        .values({
          orgId: tx.orgId,
          type,
          tripId: cargo.tripId,
          orderId: row.orderId,
          tripCargoId: cargo.id,
          title: `${head} по заказу ${row.orderNumber}: принято ${formatQty(data.acceptedMilli)} из ${formatQty(base)}${detail ? `, ${detail}` : ""}`,
          responsibleUserId: responsibleId,
          dueAt: data.dueAt ?? new Date(Date.now() + 2 * DAY_MS),
        })
        .returning({ id: tasks.id });
      taskId = task.id;
    }

    await audit(tx, {
      entity: "acceptance",
      entityId: cargo.id,
      action: "record",
      before: previous ? { versionNo: previous.versionNo, accepted: previous.acceptedMilli } : undefined,
      after: { versionNo, accepted: data.acceptedMilli, rejected: data.rejectedMilli, returned: data.returnedMilli, reason: data.reasonCode },
    });
    return { versionNo, taskId };
  });
}

export type AcceptanceView = {
  id: string;
  tripCargoId: string;
  orderNumber: string;
  product: string | null;
  unit: string | null;
  stopName: string;
  qtyMilli: number;
  loadedMilli: number | null;
  versionNo: number;
  isCurrent: boolean;
  acceptedMilli: number;
  rejectedMilli: number;
  returnedMilli: number;
  reasonCode: ReasonCode | null;
  confirmation: string | null;
  createdAt: Date;
  createdByName: string;
};

/** Acceptance of a trip: the current version per cargo row, and every version ever saved. */
export async function listAcceptance(ctx: Ctx, tripId: string): Promise<{ current: AcceptanceView[]; history: AcceptanceView[] }> {
  requireCan(ctx, "trips.read");
  const [trip] = await ctx.db.select({ id: trips.id }).from(trips).where(and(eq(trips.id, tripId), eq(trips.orgId, ctx.orgId)));
  if (!trip) throw new DomainError("not_found", "Рейс не найден");

  const rows = await ctx.db
    .select({
      a: acceptances,
      cargo: tripCargo,
      orderNumber: orders.number,
      product: orderLines.product,
      unit: orderLines.unit,
      stopSeq: tripStops.seq,
      userName: users.name,
    })
    .from(acceptances)
    .innerJoin(tripCargo, eq(tripCargo.id, acceptances.tripCargoId))
    .innerJoin(orderLines, eq(orderLines.id, tripCargo.orderLineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(tripStops, eq(tripStops.id, tripCargo.stopId))
    .innerJoin(users, eq(users.id, acceptances.createdBy))
    .where(and(eq(tripCargo.tripId, tripId), eq(acceptances.orgId, ctx.orgId)))
    .orderBy(asc(tripStops.seq), asc(orders.number), desc(acceptances.versionNo));

  const views = rows.map(
    ({ a, cargo, orderNumber, product, unit, userName, stopSeq }): AcceptanceView => ({
      id: a.id,
      tripCargoId: a.tripCargoId,
      orderNumber,
      product,
      unit,
      stopName: `Остановка ${stopSeq}`,
      qtyMilli: cargo.qtyMilli,
      loadedMilli: cargo.loadedMilli,
      versionNo: a.versionNo,
      isCurrent: a.isCurrent,
      acceptedMilli: a.acceptedMilli,
      rejectedMilli: a.rejectedMilli,
      returnedMilli: a.returnedMilli,
      reasonCode: a.reasonCode,
      confirmation: a.confirmation,
      createdAt: a.createdAt,
      createdByName: userName,
    }),
  );
  return {
    current: views.filter((v) => v.isCurrent),
    history: [...views].sort((x, y) => y.versionNo - x.versionNo),
  };
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  shortage: "Недостача",
  damage: "Повреждение",
  quality: "Качество",
  docs_mismatch: "Расхождение в документах",
  refused: "Отказ получателя",
  other: "Другое",
};
