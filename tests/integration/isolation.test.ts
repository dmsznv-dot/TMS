import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import type { Ctx } from "@/server/auth/context";
import type { Db } from "@/server/db/client";
import * as exportModule from "@/server/export";
import { DATASETS } from "@/server/export";
import * as importJobs from "@/server/import/jobs";
import * as acceptance from "@/server/services/acceptance";
import * as close from "@/server/services/close";
import * as economics from "@/server/services/economics";
import * as execution from "@/server/services/execution";
import * as finance from "@/server/services/finance";
import * as history from "@/server/services/history";
import * as offers from "@/server/services/offers";
import * as orders from "@/server/services/orders";
import * as planning from "@/server/services/planning";
import * as refs from "@/server/services/refs";
import * as shareLinks from "@/server/services/shareLinks";
import * as tasks from "@/server/services/tasks";
import * as triage from "@/server/services/triage";
import * as trips from "@/server/services/trips";
import * as users from "@/server/services/users";
import { makeOrg } from "../helpers/factories";
import { makeAssignedTrip } from "../helpers/scenarios";
import { withTestDb } from "../helpers/testDb";

let db: Db;
let close_: () => Promise<void>;

beforeAll(async () => {
  ({ db, close: close_ } = await withTestDb());
});
afterAll(async () => {
  await close_();
});

const MODULES: Record<string, Record<string, unknown>> = {
  users, refs, orders, trips, planning, offers, shareLinks, execution, acceptance, tasks, finance, economics, close, triage, history, importJobs, export: exportModule,
};

/** Everything organization A owns, by name, so another organization can reach for it. */
type World = {
  adminUserId: string;
  tripId: string;
  stopId: string;
  cargoId: string;
  orderId: string;
  lineId: string;
  locationId: string;
  vehicleId: string;
  driverId: string;
  carrierId: string;
  customerId: string;
  expenseId: string;
  accrualId: string;
  invoiceId: string;
  paymentId: string;
  documentId: string;
  offerId: string;
  taskId: string;
  linkId: string;
  jobId: string;
  rowId: string;
  templateId: string;
  /** Strings that must never show up in what another organization gets back. */
  secrets: string[];
};

async function buildWorld(): Promise<{ world: World; orgId: string }> {
  const t = await makeAssignedTrip(db);
  const logist = t.logist;
  const finance_ = await t.org.as("finance");
  const admin = await t.org.as("admin");
  const [, shopA] = t.trip.stops;
  const cargo = shopA.cargo[0];

  await execution.recordEvent(logist, { tripId: t.tripId, type: "loading_started", stopId: t.trip.stops[0].id });
  await acceptance.recordAcceptance(logist, { tripCargoId: cargo.id, acceptedMilli: 3_000, rejectedMilli: 0, returnedMilli: 0, reasonCode: "shortage" });
  const [task] = await tasks.listTasks(logist, { tripId: t.tripId });

  const { id: customerId } = await refs.createCounterparty(logist, { name: "ООО Секрет", kind: "customer" });
  const { id: carrierId } = await refs.createCounterparty(logist, { name: "ИП Секретов", kind: "carrier" });
  const { expenseId } = await finance.addExpense(finance_, { tripId: t.tripId, category: "fuel", amountKop: 123_456, date: new Date() });
  const { accrualId } = await finance.addAccrual(finance_, { tripId: t.tripId, kind: "surcharge", description: "Простой-секрет", amountKop: 600_000, vatIncluded: false });
  const { invoiceId } = await finance.createInvoice(finance_, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "SECRET-1", date: new Date(), dueDate: new Date(), amountKop: 700_000, vatIncluded: false });
  const { paymentId } = await finance.recordPayment(finance_, { direction: "in", counterpartyId: customerId, date: new Date(), amountKop: 333_300, purpose: "секретный платёж" });
  const { documentId } = await finance.addDocument(logist, { tripId: t.tripId, kind: "ТН-секрет" });
  const { offerId } = await offers.addCarrierOffer(logist, { tripId: t.tripId, carrierId, rateKop: 555_000, vatIncluded: false });
  const { token } = await shareLinks.createShareLink(logist, { tripId: t.tripId });
  const [link] = await shareLinks.listShareLinks(logist, t.tripId);
  void token;

  const { templateId } = await importJobs.saveTemplate(admin, {
    name: "Секретный шаблон",
    mapping: {
      columns: { number: "Номер", locationKey: "Точка", windowStart: "С", windowEnd: "До", qty: "Кол-во" },
      dateFormat: "dd.MM.yyyy HH:mm",
      timezone: "location",
    },
  });
  const bytes = Buffer.from("Номер;Точка;С;До;Кол-во\nSECRET-ORD;NOWHERE;12.11.2026 09:00;12.11.2026 14:00;5\n", "utf8");
  const { jobId } = await importJobs.createImportJob(logist, { filename: "секрет.csv", bytes, templateId });
  await importJobs.validateImportJob(logist, jobId);
  const [row] = await importJobs.listImportRows(logist, jobId);

  // Every row id of every table of A: none of them may reach another organization.
  const tables = await db.execute(sql`select table_name from information_schema.columns where table_schema = current_schema() and column_name = 'org_id'`);
  const secrets = new Set<string>(["Секрет", "SECRET", "секрет"]);
  for (const { table_name } of tables.rows as { table_name: string }[]) {
    const rows = await db.execute(sql`select id::text as id from ${sql.identifier(table_name)} where org_id = ${t.org.orgId}`);
    for (const r of rows.rows as { id: string }[]) secrets.add(r.id);
  }
  for (const stop of t.trip.stops) for (const c of stop.cargo) secrets.add(c.orderNumber);

  return {
    orgId: t.org.orgId,
    world: {
      adminUserId: t.org.adminUserId,
      tripId: t.tripId,
      stopId: shopA.id,
      cargoId: cargo.id,
      orderId: cargo.orderId,
      lineId: cargo.orderLineId,
      locationId: shopA.location.id,
      vehicleId: t.vehicleId,
      driverId: t.driverId,
      carrierId,
      customerId,
      expenseId,
      accrualId,
      invoiceId,
      paymentId,
      documentId,
      offerId,
      taskId: task.id,
      linkId: link.id,
      jobId,
      rowId: row.id,
      templateId,
      secrets: [...secrets],
    },
  };
}

type Probe = (b: Ctx, a: World) => Promise<unknown>;
const D = new Date("2026-11-12T03:00:00Z");
const NOW = new Date();
const win = { windowStart: D, windowEnd: new Date("2026-11-12T07:00:00Z") };

/** One call per exported function: organization B reaching for what A owns (or acting in its own right). */
const PROBES: Record<string, Probe> = {
  // users
  createUser: (b) => users.createUser(b, { email: `x-${Math.random().toString(36).slice(2)}@example.test`, name: "X", role: "logist", password: "password-123" }),
  setUserActive: (b, a) => users.setUserActive(b, { userId: a.adminUserId, active: false }),
  listUsers: (b) => users.listUsers(b),
  getOrgSettings: (b) => users.getOrgSettings(b),
  updateOrgSettings: (b) => users.updateOrgSettings(b, { windowBufferMin: 20 }),
  listAssignableUsers: (b) => users.listAssignableUsers(b),
  // refs
  listCounterparties: (b) => refs.listCounterparties(b),
  getCounterparty: (b, a) => refs.getCounterparty(b, a.customerId),
  updateCounterparty: (b, a) => refs.updateCounterparty(b, a.customerId, { name: "Взлом" }),
  setCounterpartyActive: (b, a) => refs.setCounterpartyActive(b, a.customerId, false),
  createCounterparty: (b) => refs.createCounterparty(b, { name: "Свой", kind: "customer" }),
  listLocations: (b) => refs.listLocations(b),
  getLocation: (b, a) => refs.getLocation(b, a.locationId),
  updateLocation: (b, a) => refs.updateLocation(b, a.locationId, { serviceMin: 1 }),
  setLocationActive: (b, a) => refs.setLocationActive(b, a.locationId, false),
  createLocation: (b) => refs.createLocation(b, { name: "Своя", lat: 55, lon: 83, tz: "Asia/Novosibirsk", kind: "customer" }),
  listVehicles: (b) => refs.listVehicles(b),
  getVehicle: (b, a) => refs.getVehicle(b, a.vehicleId),
  updateVehicle: (b, a) => refs.updateVehicle(b, a.vehicleId, { plate: "ВЗЛОМ" }),
  setVehicleActive: (b, a) => refs.setVehicleActive(b, a.vehicleId, false),
  createVehicle: (b) => refs.createVehicle(b, { plate: "Х001ХХ" }),
  listDrivers: (b) => refs.listDrivers(b),
  getDriver: (b, a) => refs.getDriver(b, a.driverId),
  updateDriver: (b, a) => refs.updateDriver(b, a.driverId, { name: "Взлом" }),
  setDriverActive: (b, a) => refs.setDriverActive(b, a.driverId, false),
  createDriver: (b) => refs.createDriver(b, { name: "Свой" }),
  // orders
  // The result echoes the id it was asked about, so only the numbers are compared: they must all be zero.
  lineProgress: async (b, a) => [...(await orders.lineProgress(b, [a.lineId])).values()],
  upsertOrder: (b, a) => orders.upsertOrder(b, { source: "manual", number: "X-1", locationId: a.locationId, ...win, lines: [{ lineKey: "1", qtyMilli: 1000 }] }),
  listOrders: (b) => orders.listOrders(b),
  getOrder: (b, a) => orders.getOrder(b, a.orderId),
  cancelOrder: (b, a) => orders.cancelOrder(b, a.orderId),
  // trips
  lockTrip: (b, a) => trips.lockTrip(b, a.tripId, undefined, null),
  bumpVersion: (b, a) => trips.bumpVersion(b, a.tripId),
  createTrip: (b, a) => trips.createTrip(b, { originLocationId: a.locationId }),
  addOrderToTrip: (b, a) => trips.addOrderToTrip(b, { tripId: a.tripId, expectedVersion: 1, items: [{ orderLineId: a.lineId, qtyMilli: 1000 }] }),
  removeCargo: (b, a) => trips.removeCargo(b, { tripId: a.tripId, expectedVersion: 1, tripCargoId: a.cargoId }),
  reorderStops: (b, a) => trips.reorderStops(b, { tripId: a.tripId, expectedVersion: 1, stopIds: [a.stopId] }),
  moveTrip: (b, a) => trips.moveTrip(b, a.tripId, "cancelled", { cancelReason: "взлом" }),
  transitionTrip: (b, a) => trips.transitionTrip(b, { tripId: a.tripId, expectedVersion: 1, to: "cancelled", cancelReason: "взлом" }),
  getTrip: (b, a) => trips.getTrip(b, a.tripId),
  loadTrip: (b, a) => trips.loadTrip(b, a.tripId),
  listTrips: (b) => trips.listTrips(b),
  // planning
  calculateRoutes: (b, a) => planning.calculateRoutes(b, { tripId: a.tripId, departureAt: D, vehicleId: null, avoidToll: false }),
  listExecutorOptions: (b, a) => planning.listExecutorOptions(b, { tripId: a.tripId, departureAt: D, variants: [{ token: "x" }] }),
  savePlan: (b, a) =>
    planning.savePlan(b, {
      tripId: a.tripId,
      expectedVersion: 1,
      reason: "взлом",
      executor: { kind: "own", vehicleId: a.vehicleId, driverId: a.driverId },
      departureAt: D,
      route: { kind: "manual", distanceM: 1000, durationS: 600 },
      toll: { kind: "none" },
      otherKop: 0,
    }),
  assignTrip: (b, a) => planning.assignTrip(b, { tripId: a.tripId, expectedVersion: 1 }),
  listPlanVersions: (b, a) => planning.listPlanVersions(b, a.tripId),
  // offers
  addCarrierOffer: (b, a) => offers.addCarrierOffer(b, { tripId: a.tripId, carrierId: a.carrierId, rateKop: 1000, vatIncluded: false }),
  setOfferStatus: (b, a) => offers.setOfferStatus(b, { offerId: a.offerId, status: "rejected" }),
  loadOffers: (b, a) => offers.loadOffers(b, a.tripId),
  listOffers: (b, a) => offers.listOffers(b, a.tripId),
  // share links
  createShareLink: (b, a) => shareLinks.createShareLink(b, { tripId: a.tripId }),
  listShareLinks: (b, a) => shareLinks.listShareLinks(b, a.tripId),
  revokeShareLink: (b, a) => shareLinks.revokeShareLink(b, a.linkId),
  // execution
  recordEvent: (b, a) => execution.recordEvent(b, { tripId: a.tripId, type: "driver_confirmed" }),
  confirmLoading: (b, a) => execution.confirmLoading(b, { tripId: a.tripId, items: [{ tripCargoId: a.cargoId, loadedMilli: 1 }] }),
  setStopFact: (b, a) => execution.setStopFact(b, { stopId: a.stopId, arriveAt: NOW }),
  setMileage: (b, a) => execution.setMileage(b, { tripId: a.tripId, km: 1, unknown: false }),
  getDriverView: (b) => execution.getDriverView(b),
  listTripEvents: (b, a) => execution.listTripEvents(b, a.tripId),
  // acceptance
  recordAcceptance: (b, a) => acceptance.recordAcceptance(b, { tripCargoId: a.cargoId, acceptedMilli: 1, rejectedMilli: 0, returnedMilli: 0, reasonCode: "other" }),
  listAcceptance: (b, a) => acceptance.listAcceptance(b, a.tripId),
  // tasks
  createTask: (b, a) => tasks.createTask(b, { type: "other", tripId: a.tripId, title: "взлом" }),
  completeTask: (b, a) => tasks.completeTask(b, { taskId: a.taskId, resolution: "взлом" }),
  listTasks: (b, a) => tasks.listTasks(b, { tripId: a.tripId }),
  // finance
  addExpense: (b, a) => finance.addExpense(b, { tripId: a.tripId, category: "other", amountKop: 1, date: NOW }),
  verifyExpense: (b, a) => finance.verifyExpense(b, a.expenseId),
  markNotIncurred: (b, a) => finance.markNotIncurred(b, { tripId: a.tripId, category: "tolls" }),
  linkExpense: (b, a) => finance.linkExpense(b, { expenseId: a.expenseId, tripId: a.tripId }),
  listExpenses: (b, a) => finance.listExpenses(b, { tripId: a.tripId }),
  addAccrual: (b, a) => finance.addAccrual(b, { tripId: a.tripId, kind: "surcharge", description: "взлом", amountKop: 1, vatIncluded: false }),
  createInvoice: (b, a) => finance.createInvoice(b, { direction: "out", counterpartyId: a.customerId, number: "X", date: NOW, dueDate: NOW, amountKop: 1, vatIncluded: false, accrualIds: [a.accrualId] }),
  listInvoices: (b, a) => finance.listInvoices(b, { tripId: a.tripId }),
  recordPayment: (b, a) => finance.recordPayment(b, { direction: "in", counterpartyId: a.customerId, date: NOW, amountKop: 1, purpose: "x" }),
  allocatePayment: (b, a) => finance.allocatePayment(b, { paymentId: a.paymentId, invoiceId: a.invoiceId, amountKop: 1 }),
  listPayments: (b) => finance.listPayments(b),
  addDocument: (b, a) => finance.addDocument(b, { tripId: a.tripId, kind: "взлом" }),
  setDocumentStatus: (b, a) => finance.setDocumentStatus(b, { documentId: a.documentId, status: "rejected" }),
  listDocuments: (b, a) => finance.listDocuments(b, a.tripId),
  // economics, close, triage, history
  getTripEconomics: (b, a) => economics.getTripEconomics(b, a.tripId),
  getCompleteness: (b, a) => close.getCompleteness(b, a.tripId),
  closeTrip: (b, a) => close.closeTrip(b, { tripId: a.tripId, expectedVersion: 1, overrideReason: "взлом" }),
  getTriage: (b) => triage.getTriage(b),
  listTripHistory: (b, a) => history.listTripHistory(b, a.tripId),
  // import
  saveTemplate: (b) =>
    importJobs.saveTemplate(b, {
      name: "Свой шаблон",
      mapping: { columns: { number: "Номер", locationKey: "Точка", windowStart: "С", windowEnd: "До", qty: "Кол-во" }, dateFormat: "dd.MM.yyyy HH:mm", timezone: "location" },
    }),
  listTemplates: (b) => importJobs.listTemplates(b),
  createImportJob: (b, a) => importJobs.createImportJob(b, { filename: "x.csv", bytes: Buffer.from("Номер;Точка\nA;B\n", "utf8"), templateId: a.templateId }),
  validateImportJob: (b, a) => importJobs.validateImportJob(b, a.jobId),
  enqueueImportJob: (b, a) => importJobs.enqueueImportJob(b, a.jobId),
  getImportJob: (b, a) => importJobs.getImportJob(b, a.jobId),
  listImportJobs: (b) => importJobs.listImportJobs(b),
  listImportRows: (b, a) => importJobs.listImportRows(b, a.jobId),
  fixImportRow: (b, a) => importJobs.fixImportRow(b, { rowId: a.rowId, raw: {} }),
  // export
  exportDataset: async (b) => {
    const files = await Promise.all(DATASETS.map((d) => exportModule.exportDataset(b, d, "csv")));
    return files.map((f) => f.body.toString("utf8"));
  },
};

/** Exported functions that are not an organization reaching for another's data, with the reason. */
const EXEMPT: Record<string, string> = {
  createOrganization: "creates a new organization from nothing; there is no other organization to reach",
  truckProfileOf: "pure function of a row it is given",
  isPlanStale: "pure function of two views it is given",
  routeBinding: "pure function of a trip view it is given",
  ctxFromShareToken: "the token is the credential: a valid token reaches exactly its own trip (see execution tests)",
  processNextJob: "the queue worker acts for the organization of each job it takes, not for a caller",
};

/** Every exported function; constants and types are not operations. */
const functionsOf = () =>
  Object.entries(MODULES).flatMap(([moduleName, exports]) =>
    Object.entries(exports)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => ({ moduleName, name })),
  );

describe("organization isolation", () => {
  it("covers every exported service function with a probe or a stated reason", () => {
    const names = functionsOf().map((f) => f.name);
    const covered = new Set([...Object.keys(PROBES), ...Object.keys(EXEMPT)]);
    const missing = names.filter((n) => !covered.has(n));
    expect(missing, "add a probe to PROBES, or a reason to EXEMPT, for each new function").toEqual([]);
    const stale = [...covered].filter((n) => !names.includes(n));
    expect(stale, "these probes no longer match an exported function").toEqual([]);
  });

  it("lets nobody reach another organization's data through any of them", async () => {
    const { world, orgId } = await buildWorld();
    const other = await makeOrg(db);
    const b = await other.as("admin");

    const snapshot = async () => {
      const tables = await db.execute(sql`select table_name from information_schema.columns where table_schema = current_schema() and column_name = 'org_id' order by table_name`);
      const parts: string[] = [];
      for (const { table_name } of tables.rows as { table_name: string }[]) {
        const rows = await db.execute(sql`select * from ${sql.identifier(table_name)} where org_id = ${orgId} order by id`);
        parts.push(`${table_name}:${JSON.stringify(rows.rows)}`);
      }
      return parts.join("\n");
    };
    const before = await snapshot();

    const problems: string[] = [];
    let last = before;
    const checkUnchanged = async (name: string) => {
      const now = await snapshot();
      if (now === last) return;
      const was = last.split("\n");
      const changed = now.split("\n").filter((line, i) => line !== was[i]).map((l) => l.slice(0, l.indexOf(":")));
      problems.push(`${name}: changed rows of this organization in ${changed.join(", ")}`);
      last = now;
    };
    for (const [name, probe] of Object.entries(PROBES)) {
      let result: unknown;
      try {
        result = await probe(b, world);
      } catch (e) {
        if (!(e instanceof DomainError)) problems.push(`${name}: threw ${(e as Error).message}`);
        await checkUnchanged(name);
        continue;
      }
      const text = JSON.stringify(result, (_k, v) => (v instanceof Map ? [...v] : v)) ?? "";
      const leaked = world.secrets.find((s) => text.includes(s));
      if (leaked) problems.push(`${name}: returned something of the other organization (${leaked})`);
      await checkUnchanged(name);
    }
    expect(problems).toEqual([]);
    expect(await snapshot(), "another organization changed this organization's rows").toEqual(before);
  });
});
