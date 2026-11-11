import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { allows, requireCan, type Ctx } from "../auth/context";
import { orders, tasks, trips, users, type TaskType } from "../db/schema";
import { audit, inTransaction } from "./audit";
import { parseInput } from "./validation";

const TASK_TYPES = ["shortfall", "rejection", "return", "bill_surcharge", "other"] as const;

export const taskInput = z.object({
  type: z.enum(TASK_TYPES),
  tripId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  title: z.string().trim().min(1, "Опишите задачу"),
  responsibleUserId: z.uuid().optional(),
  dueAt: z.date().optional(),
});

/** Tasks come from warehouse and planning work and from billing, so either permission is enough. */
function requireTaskWriter(ctx: Ctx) {
  if (!allows(ctx, "execution.write") && !allows(ctx, "money.write")) requireCan(ctx, "execution.write");
}

export async function createTask(ctx: Ctx, input: z.input<typeof taskInput>): Promise<{ taskId: string }> {
  requireTaskWriter(ctx);
  const data = parseInput(taskInput, input);
  return inTransaction(ctx, async (tx) => {
    if (data.tripId) {
      const [trip] = await tx.db.select({ id: trips.id }).from(trips).where(and(eq(trips.id, data.tripId), eq(trips.orgId, tx.orgId)));
      if (!trip) throw new DomainError("not_found", "Рейс не найден");
    }
    if (data.orderId) {
      const [order] = await tx.db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, data.orderId), eq(orders.orgId, tx.orgId)));
      if (!order) throw new DomainError("not_found", "Заказ не найден");
    }
    const responsible = data.responsibleUserId ?? (tx.actor.kind === "user" ? tx.actor.userId : undefined);
    const [row] = await tx.db
      .insert(tasks)
      .values({
        orgId: tx.orgId,
        type: data.type as TaskType,
        tripId: data.tripId ?? null,
        orderId: data.orderId ?? null,
        title: data.title,
        responsibleUserId: responsible ?? null,
        dueAt: data.dueAt ?? null,
      })
      .returning({ id: tasks.id });
    await audit(tx, { entity: "task", entityId: row.id, action: "create", after: { tripId: data.tripId, type: data.type, title: data.title } });
    return { taskId: row.id };
  });
}

export async function completeTask(ctx: Ctx, input: { taskId: string; resolution: string }): Promise<void> {
  requireTaskWriter(ctx);
  const resolution = parseInput(z.string().trim().min(1, "Опишите, как решена задача"), input.resolution);
  await inTransaction(ctx, async (tx) => {
    const updated = await tx.db
      .update(tasks)
      .set({ status: "done", resolution, completedAt: new Date() })
      .where(and(eq(tasks.id, input.taskId), eq(tasks.orgId, tx.orgId), eq(tasks.status, "open")))
      .returning({ id: tasks.id, tripId: tasks.tripId });
    if (updated.length === 0) throw new DomainError("not_found", "Задача не найдена или уже закрыта");
    await audit(tx, { entity: "task", entityId: input.taskId, action: "complete", after: { tripId: updated[0].tripId, resolution } });
  });
}

export type TaskView = {
  id: string;
  type: TaskType;
  title: string;
  status: "open" | "done";
  resolution: string | null;
  tripId: string | null;
  tripNumber: string | null;
  orderId: string | null;
  orderNumber: string | null;
  responsibleUserId: string | null;
  responsibleName: string | null;
  dueAt: Date | null;
  createdAt: Date;
};

export async function listTasks(ctx: Ctx, filter: { status?: "open" | "done"; tripId?: string } = {}): Promise<TaskView[]> {
  requireCan(ctx, "trips.read");
  const conditions = [eq(tasks.orgId, ctx.orgId)];
  if (filter.status) conditions.push(eq(tasks.status, filter.status));
  if (filter.tripId) conditions.push(eq(tasks.tripId, filter.tripId));

  const rows = await ctx.db
    .select({
      task: tasks,
      tripNumber: trips.number,
      orderNumber: orders.number,
      responsibleName: users.name,
    })
    .from(tasks)
    .leftJoin(trips, eq(trips.id, tasks.tripId))
    .leftJoin(orders, eq(orders.id, tasks.orderId))
    .leftJoin(users, eq(users.id, tasks.responsibleUserId))
    .where(and(...conditions))
    .orderBy(sql`${tasks.status} = 'done'`, asc(tasks.dueAt), desc(tasks.createdAt))
    .limit(500);

  return rows.map(({ task, tripNumber, orderNumber, responsibleName }) => ({
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    resolution: task.resolution,
    tripId: task.tripId,
    tripNumber,
    orderId: task.orderId,
    orderNumber,
    responsibleUserId: task.responsibleUserId,
    responsibleName,
    dueAt: task.dueAt,
    createdAt: task.createdAt,
  }));
}
