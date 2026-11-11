import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import { cancelOrder, getOrder, listOrders, upsertOrder, type OrderInput } from "@/server/services/orders";
import { createLocation } from "@/server/services/refs";
import { expectCode } from "../helpers/expectCode";
import { makeOrg } from "../helpers/factories";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await withTestDb());
});
afterAll(async () => {
  await close();
});

async function setup() {
  const org = await makeOrg(db);
  const logist = await org.as("logist");
  const { id: locationId } = await createLocation(logist, {
    name: "Магазин 1",
    lat: 55.05,
    lon: 82.95,
    tz: "Asia/Novosibirsk",
    kind: "customer",
  });
  const order = (patch: Partial<OrderInput> = {}): OrderInput => ({
    source: "manual",
    number: "З-1001",
    locationId,
    customerName: "ООО Ромашка",
    windowStart: new Date("2026-11-12T02:00:00Z"),
    windowEnd: new Date("2026-11-12T07:00:00Z"),
    lines: [{ lineKey: "Вода 0,5", product: "Вода 0,5", unit: "палл", qtyMilli: 10_000, priceKop: 500_000, costKop: 300_000 }],
    ...patch,
  });
  return { org, logist, locationId, order };
}

describe("upsertOrder", () => {
  it("adds, then skips an identical order", async () => {
    const { logist, order } = await setup();
    const first = await upsertOrder(logist, order());
    const second = await upsertOrder(logist, order());

    expect(first.result).toBe("added");
    expect(second).toMatchObject({ orderId: first.orderId, result: "skipped" });
    expect(await listOrders(logist)).toHaveLength(1);
  });

  it("updates when the window changes", async () => {
    const { logist, order } = await setup();
    await upsertOrder(logist, order());
    const changed = await upsertOrder(logist, order({ windowEnd: new Date("2026-11-12T09:00:00Z") }));

    expect(changed.result).toBe("updated");
    expect((await getOrder(logist, changed.orderId)).windowEnd.toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });

  it("reports a result for each line and keeps lines absent from the input", async () => {
    const { logist, order } = await setup();
    const { orderId } = await upsertOrder(logist, order());
    const next = await upsertOrder(
      logist,
      order({ lines: [{ lineKey: "Сок 1л", product: "Сок 1л", unit: "палл", qtyMilli: 4_000 }] }),
    );

    expect(next.result).toBe("updated");
    expect(next.lineResults).toEqual({ "Сок 1л": "added" });
    expect((await getOrder(logist, orderId)).lines.map((l) => l.lineKey).sort()).toEqual(["Вода 0,5", "Сок 1л"]);
  });

  it("treats the same number from another source as a different order", async () => {
    const { logist, order } = await setup();
    await upsertOrder(logist, order());
    const other = await upsertOrder(logist, order({ source: "template:abc" }));
    expect(other.result).toBe("added");
    expect(await listOrders(logist)).toHaveLength(2);
  });

  it("rejects a window that ends before it starts", async () => {
    const { logist, order } = await setup();
    await expectCode(upsertOrder(logist, order({ windowEnd: new Date("2026-11-12T01:00:00Z") })), "validation");
  });

  it("rejects a non-positive quantity and an order without lines", async () => {
    const { logist, order } = await setup();
    await expectCode(upsertOrder(logist, order({ lines: [{ lineKey: "x", qtyMilli: 0 }] })), "validation");
    await expectCode(upsertOrder(logist, order({ lines: [] })), "validation");
  });

  it("rejects a location of another organization", async () => {
    const { order } = await setup();
    const other = await makeOrg(db);
    await expectCode(upsertOrder(await other.as("logist"), order()), "location_not_found");
  });

  it("requires planning.write", async () => {
    const { org, order } = await setup();
    await expectCode(upsertOrder(await org.as("warehouse"), order()), "forbidden");
  });
});

describe("reading orders", () => {
  it("shows the whole quantity as remaining for a new order", async () => {
    const { logist, order } = await setup();
    await upsertOrder(logist, order());
    const [item] = await listOrders(logist);

    expect(item.status).toBe("new");
    expect(item.location.name).toBe("Магазин 1");
    expect(item.lines[0]).toMatchObject({ qtyMilli: 10_000, remainingMilli: 10_000 });
  });

  it("filters by status and searches by number or customer", async () => {
    const { logist, order } = await setup();
    await upsertOrder(logist, order());
    await upsertOrder(logist, order({ number: "З-2002", customerName: "ИП Василёк" }));

    expect((await listOrders(logist, { search: "2002" })).map((o) => o.number)).toEqual(["З-2002"]);
    expect((await listOrders(logist, { search: "ромаш" })).map((o) => o.number)).toEqual(["З-1001"]);
    expect(await listOrders(logist, { status: "delivered" })).toEqual([]);
  });

  it("hides another organization's orders", async () => {
    const { logist, order } = await setup();
    const { orderId } = await upsertOrder(logist, order());
    const stranger: Ctx = await (await makeOrg(db)).as("logist");

    expect(await listOrders(stranger)).toEqual([]);
    await expectCode(getOrder(stranger, orderId), "not_found");
  });

  it("hides prices from a role without access to money", async () => {
    const { org, logist, order } = await setup();
    const { orderId } = await upsertOrder(logist, order());

    expect((await getOrder(logist, orderId)).lines[0].priceKop).toBe(500_000);
    const forWarehouse = await getOrder(await org.as("warehouse"), orderId);
    expect(forWarehouse.lines[0].priceKop).toBeNull();
    expect(forWarehouse.lines[0].costKop).toBeNull();
  });

  it("marks a cancelled order", async () => {
    const { logist, order } = await setup();
    const { orderId } = await upsertOrder(logist, order());
    await cancelOrder(logist, orderId);
    expect((await getOrder(logist, orderId)).status).toBe("cancelled");
  });
});
