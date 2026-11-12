import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { listAcceptance, recordAcceptance } from "@/server/services/acceptance";
import { confirmLoading, recordEvent } from "@/server/services/execution";
import { getOrder } from "@/server/services/orders";
import { completeTask, createTask, listTasks } from "@/server/services/tasks";
import { getTrip } from "@/server/services/trips";
import { expectCode } from "../helpers/expectCode";
import { makeOrg } from "../helpers/factories";
import { makeAssignedTrip, type AssignedTrip } from "../helpers/scenarios";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

const startTrip = (t: AssignedTrip) => recordEvent(t.logist, { tripId: t.tripId, type: "loading_started", stopId: t.trip.stops[0].id });

async function completeTrip(t: AssignedTrip) {
  for (const stop of t.trip.stops) {
    await recordEvent(t.logist, { tripId: t.tripId, type: stop.operation === "load" ? "loaded" : "unloaded", stopId: stop.id });
  }
  expect((await getTrip(t.logist, t.tripId)).status).toBe("completed");
}

/** The cargo row delivered to the first shop: 5 of a 10-unit order line. */
const cargoOf = (t: AssignedTrip) => t.trip.stops[1].cargo[0];
const remaining = async (t: AssignedTrip) => (await getOrder(t.logist, cargoOf(t).orderId)).lines[0].remainingMilli;

describe("recordAcceptance", () => {
  it("records full acceptance without a task", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const wh = await t.org.as("warehouse");
    const result = await recordAcceptance(wh, { tripCargoId: cargoOf(t).id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0, confirmation: "Подпись получателя" });

    expect(result).toEqual({ versionNo: 1, taskId: null });
    expect(await listTasks(t.logist, { tripId: t.tripId })).toEqual([]);
    const [row] = (await listAcceptance(t.logist, t.tripId)).current;
    expect(row).toMatchObject({ acceptedMilli: 5_000, confirmation: "Подпись получателя", versionNo: 1 });
  });

  it("requires a reason for a shortage and creates a task with a responsible person and a due date", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const wh = await t.org.as("warehouse");
    const input = { tripCargoId: cargoOf(t).id, acceptedMilli: 3_000, rejectedMilli: 0, returnedMilli: 0 };

    await expectCode(recordAcceptance(wh, input), "reason_required");
    const { taskId } = await recordAcceptance(wh, { ...input, reasonCode: "shortage" });

    const [task] = await listTasks(t.logist, { tripId: t.tripId });
    expect(task).toMatchObject({ id: taskId, type: "shortfall", status: "open", tripNumber: t.trip.number });
    expect(task.title).toContain("принято 3 из 5");
    expect(task.responsibleUserId).toBeTruthy();
    expect(task.dueAt!.getTime()).toBeGreaterThan(Date.now() + 24 * 3600_000);
  });

  it("uses the person and date given for the task", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const finance = await t.org.as("finance");
    const responsible = (finance.actor as { userId: string }).userId;
    const dueAt = new Date("2026-12-01T09:00:00Z");
    await recordAcceptance(await t.org.as("warehouse"), {
      tripCargoId: cargoOf(t).id,
      acceptedMilli: 4_000,
      rejectedMilli: 1_000,
      returnedMilli: 0,
      reasonCode: "damage",
      responsibleUserId: responsible,
      dueAt,
    });
    const [task] = await listTasks(t.logist, { tripId: t.tripId });
    expect(task).toMatchObject({ type: "rejection", responsibleUserId: responsible });
    expect(task.dueAt).toEqual(dueAt);
  });

  it("makes a return task when goods are returned", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    await recordAcceptance(t.logist, { tripCargoId: cargoOf(t).id, acceptedMilli: 3_000, rejectedMilli: 0, returnedMilli: 2_000, reasonCode: "refused" });
    expect((await listTasks(t.logist, { tripId: t.tripId }))[0].type).toBe("return");
  });

  it("keeps the order quantity and keeps the shortage plannable after the trip completes", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    expect(await remaining(t)).toBe(5_000); // 10 ordered, 5 on this trip

    await completeTrip(t);
    // Delivered but not yet accepted: still counted as on the trip, so it cannot be sent twice.
    expect(await remaining(t)).toBe(5_000);

    await recordAcceptance(t.logist, { tripCargoId: cargoOf(t).id, acceptedMilli: 3_000, rejectedMilli: 0, returnedMilli: 0, reasonCode: "shortage" });
    const order = await getOrder(t.logist, cargoOf(t).orderId);
    expect(order.lines[0]).toMatchObject({ qtyMilli: 10_000, deliveredMilli: 3_000, allocatedOpenMilli: 0, remainingMilli: 7_000 });
    expect(order.status).toBe("partially_delivered");
  });

  it("returns rejected goods to the pool while the trip is still running", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    await recordAcceptance(t.logist, { tripCargoId: cargoOf(t).id, acceptedMilli: 3_000, rejectedMilli: 2_000, returnedMilli: 0, reasonCode: "quality" });
    // 5 on the trip: 3 accepted, 2 rejected come back; the other 5 of the line were never planned.
    expect(await remaining(t)).toBe(7_000);
  });

  it("keeps an order partially delivered while part of it was never shipped", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    await completeTrip(t);
    for (const stop of t.trip.stops.slice(1)) {
      await recordAcceptance(t.logist, { tripCargoId: stop.cargo[0].id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 });
    }
    // Each order line was 10 with 5 shipped and fully accepted; the other 5 are still to be planned.
    expect((await getOrder(t.logist, cargoOf(t).orderId)).status).toBe("partially_delivered");
  });

  it("creates a new version, keeps the previous one and closes the old task", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const base = { tripCargoId: cargoOf(t).id, rejectedMilli: 0, returnedMilli: 0 };
    await recordAcceptance(t.logist, { ...base, acceptedMilli: 3_000, reasonCode: "shortage" });
    const second = await recordAcceptance(t.logist, { ...base, acceptedMilli: 5_000 });

    expect(second).toEqual({ versionNo: 2, taskId: null });
    const { current, history } = await listAcceptance(t.logist, t.tripId);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ versionNo: 2, acceptedMilli: 5_000 });
    expect(history.map((h) => [h.versionNo, h.acceptedMilli, h.isCurrent])).toEqual([[2, 5_000, true], [1, 3_000, false]]);
    const [task] = await listTasks(t.logist, { tripId: t.tripId });
    expect(task.status).toBe("done");
    expect(task.resolution).toContain("новой версией приёмки");
  });

  it("does not keep a reason on a full acceptance", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    await recordAcceptance(t.logist, { tripCargoId: cargoOf(t).id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0, reasonCode: "shortage" });
    const [row] = (await listAcceptance(t.logist, t.tripId)).current;
    expect(row.reasonCode).toBeNull();
  });

  it("replaces the old task with a new one when the shortage changes", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const base = { tripCargoId: cargoOf(t).id, rejectedMilli: 0, returnedMilli: 0, reasonCode: "shortage" as const };
    await recordAcceptance(t.logist, { ...base, acceptedMilli: 3_000 });
    await recordAcceptance(t.logist, { ...base, acceptedMilli: 4_000 });
    const tasks = await listTasks(t.logist, { tripId: t.tripId });
    expect(tasks.map((x) => x.status).sort()).toEqual(["done", "open"]);
  });

  it("rejects totals above the loaded quantity, or above the planned one when loading is not confirmed", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const wh = await t.org.as("warehouse");
    const input = { tripCargoId: cargoOf(t).id, rejectedMilli: 0, returnedMilli: 0, reasonCode: "other" as const };
    await expectCode(recordAcceptance(wh, { ...input, acceptedMilli: 5_001 }), "exceeds_loaded");

    await confirmLoading(wh, { tripId: t.tripId, items: [{ tripCargoId: cargoOf(t).id, loadedMilli: 4_000 }] });
    await expectCode(recordAcceptance(wh, { ...input, acceptedMilli: 3_000, rejectedMilli: 1_500 }), "exceeds_loaded");
    // With 4 loaded, accepting all 4 is a full acceptance of what was loaded.
    expect((await recordAcceptance(wh, { ...input, acceptedMilli: 4_000 })).taskId).toBeNull();
  });

  it("rejects negative quantities", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const base = { tripCargoId: cargoOf(t).id, reasonCode: "other" as const };
    await expectCode(recordAcceptance(t.logist, { ...base, acceptedMilli: -1, rejectedMilli: 0, returnedMilli: 0 }), "validation");
  });

  it("records that nothing was accepted as a shortage with a task", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const { taskId } = await recordAcceptance(t.logist, { tripCargoId: cargoOf(t).id, acceptedMilli: 0, rejectedMilli: 0, returnedMilli: 0, reasonCode: "refused" });
    expect(taskId).toBeTruthy();
    expect((await listTasks(t.logist, { tripId: t.tripId }))[0].title).toContain("принято 0 из 5");
  });

  it("rejects a responsible person from another organization", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const stranger = (await (await makeOrg(db)).as("logist")).actor as { userId: string };
    await expectCode(
      recordAcceptance(t.logist, { tripCargoId: cargoOf(t).id, acceptedMilli: 1_000, rejectedMilli: 0, returnedMilli: 0, reasonCode: "shortage", responsibleUserId: stranger.userId }),
      "not_found",
    );
  });

  it("is accepted only once the trip has left", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(
      recordAcceptance(t.logist, { tripCargoId: cargoOf(t).id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 }),
      "trip_not_active",
    );
  });

  it("is allowed for the warehouse and refused for finance", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const input = { tripCargoId: cargoOf(t).id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 };
    await expectCode(recordAcceptance(await t.org.as("finance"), input), "forbidden");
    await recordAcceptance(await t.org.as("warehouse"), input);
  });

  it("is isolated between organizations", async () => {
    const t = await makeAssignedTrip(db);
    await startTrip(t);
    const other = await makeOrg(db);
    await expectCode(
      recordAcceptance(await other.as("logist"), { tripCargoId: cargoOf(t).id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 }),
      "not_found",
    );
    await expectCode(listAcceptance(await other.as("logist"), t.tripId), "not_found");
  });
});

describe("tasks", () => {
  it("are created by hand, filtered, and completed with a resolution", async () => {
    const t = await makeAssignedTrip(db);
    const { taskId } = await createTask(t.logist, { type: "other", tripId: t.tripId, title: "Согласовать окно с РЦ", dueAt: new Date("2026-12-01T09:00:00Z") });

    expect((await listTasks(t.logist, { status: "open" })).map((x) => x.id)).toEqual([taskId]);
    await expectCode(completeTask(t.logist, { taskId, resolution: "  " }), "validation");
    await completeTask(t.logist, { taskId, resolution: "Окно согласовано по телефону" });

    expect(await listTasks(t.logist, { status: "open" })).toEqual([]);
    expect((await listTasks(t.logist, { status: "done" }))[0]).toMatchObject({ id: taskId, resolution: "Окно согласовано по телефону" });
  });

  it("need a title and cannot be completed twice", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(createTask(t.logist, { type: "other", tripId: t.tripId, title: "  " }), "validation");
    const { taskId } = await createTask(t.logist, { type: "other", title: "Позвонить" });
    await completeTask(t.logist, { taskId, resolution: "Готово" });
    await expectCode(completeTask(t.logist, { taskId, resolution: "Ещё раз" }), "not_found");
  });

  it("can be created by finance for billing but not by the manager", async () => {
    const t = await makeAssignedTrip(db);
    await createTask(await t.org.as("finance"), { type: "bill_surcharge", tripId: t.tripId, title: "Выставить простой" });
    await expectCode(createTask(await t.org.as("manager"), { type: "other", title: "x" }), "forbidden");
  });

  it("are isolated between organizations", async () => {
    const t = await makeAssignedTrip(db);
    const other = await makeOrg(db);
    const { taskId } = await createTask(t.logist, { type: "other", title: "Моя задача" });
    expect(await listTasks(await other.as("logist"), {})).toEqual([]);
    await expectCode(completeTask(await other.as("logist"), { taskId, resolution: "x" }), "not_found");
  });
});
