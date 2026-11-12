import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";
import {
  createCounterparty,
  createDriver,
  createLocation,
  createVehicle,
  getLocation,
  getVehicle,
  listCounterparties,
  listDrivers,
  listLocations,
  listVehicles,
  setVehicleActive,
  truckProfileOf,
  updateLocation,
} from "@/server/services/refs";
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

const warehouse = {
  name: "Склад Северный",
  address: "Новосибирск, ул. Складская, 1",
  lat: 55.0302,
  lon: 82.9204,
  tz: "Asia/Novosibirsk",
  kind: "warehouse" as const,
};

describe("locations", () => {
  it("creates and lists locations within the organization only", async () => {
    const a = await makeOrg(db);
    const b = await makeOrg(db);
    const logistA = await a.as("logist");
    const { id } = await createLocation(logistA, warehouse);

    expect((await listLocations(logistA)).map((l) => l.id)).toEqual([id]);
    expect(await listLocations(await b.as("logist"))).toEqual([]);
    await expectCode(getLocation(await b.as("logist"), id), "not_found");
  });

  it("applies defaults for service time", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    const { id } = await createLocation(logist, warehouse);
    expect(await getLocation(logist, id)).toMatchObject({ serviceMin: 30, active: true });
  });

  it("rejects coordinates outside the valid range", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    await expectCode(createLocation(logist, { ...warehouse, lat: 91 }), "validation");
    await expectCode(createLocation(logist, { ...warehouse, lon: -181 }), "validation");
  });

  it("rejects an unknown time zone", async () => {
    const org = await makeOrg(db);
    await expectCode(
      createLocation(await org.as("logist"), { ...warehouse, tz: "Mars/Olympus" }),
      "validation",
    );
  });

  it("requires both coordinates of an entry point", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    await expectCode(createLocation(logist, { ...warehouse, entryLat: 55.1 }), "validation");
    const { id } = await createLocation(logist, { ...warehouse, entryLat: 55.1, entryLon: 82.9 });
    expect(await getLocation(logist, id)).toMatchObject({ entryLat: 55.1, entryLon: 82.9 });
  });

  it("enforces a unique external key per organization", async () => {
    const a = await makeOrg(db);
    const b = await makeOrg(db);
    const logistA = await a.as("logist");
    await createLocation(logistA, { ...warehouse, externalKey: "WH-1" });
    await expectCode(createLocation(logistA, { ...warehouse, externalKey: "WH-1" }), "duplicate");
    await createLocation(await b.as("logist"), { ...warehouse, externalKey: "WH-1" });
  });

  it("updates a location and records the change", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    const { id } = await createLocation(logist, warehouse);
    await updateLocation(logist, id, { serviceMin: 45 });

    expect((await getLocation(logist, id)).serviceMin).toBe(45);
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(entries.map((e) => e.action).sort()).toEqual(["create", "update"]);
  });

  it("cannot update a location of another organization", async () => {
    const a = await makeOrg(db);
    const b = await makeOrg(db);
    const { id } = await createLocation(await a.as("logist"), warehouse);
    await expectCode(updateLocation(await b.as("logist"), id, { serviceMin: 5 }), "not_found");
  });
});

describe("permissions", () => {
  it("warehouse reads reference data but cannot change it", async () => {
    const org = await makeOrg(db);
    const { id } = await createLocation(await org.as("logist"), warehouse);
    const wh = await org.as("warehouse");

    expect((await listLocations(wh)).map((l) => l.id)).toEqual([id]);
    await expectCode(createLocation(wh, warehouse), "forbidden");
    await expectCode(createDriver(wh, { name: "Иван" }), "forbidden");
  });
});

describe("vehicles", () => {
  it("deactivates instead of deleting", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    const { id } = await createVehicle(logist, { plate: "А123ВС154" });
    await setVehicleActive(logist, id, false);

    expect(await listVehicles(logist, { activeOnly: true })).toEqual([]);
    expect((await listVehicles(logist)).map((v) => v.id)).toEqual([id]);
    expect((await getVehicle(logist, id)).active).toBe(false);
  });

  it("reports an incomplete truck profile", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    const full = await createVehicle(logist, {
      plate: "В001ОР154",
      maxPermMassT: 12,
      massT: 9,
      axleLoadT: 6,
      heightM: 3.4,
      widthM: 2.5,
      lengthM: 8.2,
      passIds: [3],
    });
    const partial = await createVehicle(logist, { plate: "В002ОР154", maxPermMassT: 12, widthM: 2.5, lengthM: 8.2 });

    expect(truckProfileOf(await getVehicle(logist, full.id))).toEqual({
      profile: { maxPermMassT: 12, massT: 9, axleLoadT: 6, heightM: 3.4, widthM: 2.5, lengthM: 8.2, passIds: [3] },
      complete: true,
    });
    const incomplete = truckProfileOf(await getVehicle(logist, partial.id));
    expect(incomplete.complete).toBe(false);
    expect(incomplete.profile).toEqual({ maxPermMassT: 12, widthM: 2.5, lengthM: 8.2 });
  });

  it("rejects a negative capacity", async () => {
    const org = await makeOrg(db);
    await expectCode(createVehicle(await org.as("logist"), { plate: "Х", capacityKg: -5 }), "validation");
  });
});

describe("counterparties and drivers", () => {
  it("stores carriers and customers separately by kind", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    await createCounterparty(logist, { name: "ООО Ромашка", kind: "customer" });
    await createCounterparty(logist, { name: "ИП Перевозов", kind: "carrier", vatIncluded: false });

    const carriers = await listCounterparties(logist, { kind: "carrier" });
    expect(carriers.map((c) => c.name)).toEqual(["ИП Перевозов"]);
    expect(carriers[0].vatIncluded).toBe(false);
  });

  it("rejects an INN of the wrong length", async () => {
    const org = await makeOrg(db);
    await expectCode(
      createCounterparty(await org.as("logist"), { name: "X", kind: "customer", inn: "123" }),
      "validation",
    );
  });

  it("lists drivers of the organization", async () => {
    const org = await makeOrg(db);
    const logist = await org.as("logist");
    await createDriver(logist, { name: "Пётр Петров", phone: "+7 900 000-00-00" });
    expect((await listDrivers(logist)).map((d) => d.name)).toEqual(["Пётр Петров"]);
  });
});
