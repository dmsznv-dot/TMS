import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { auditLog } from "@/server/db/schema";
import { closeTrip, getCompleteness } from "@/server/services/close";
import { getTripEconomics } from "@/server/services/economics";
import { recordAcceptance } from "@/server/services/acceptance";
import { recordEvent, setMileage } from "@/server/services/execution";
import {
  addAccrual,
  addDocument,
  addExpense,
  allocatePayment,
  createInvoice,
  linkExpense,
  listDocuments,
  listExpenses,
  listInvoices,
  listPayments,
  markNotIncurred,
  recordPayment,
  setDocumentStatus,
  verifyExpense,
} from "@/server/services/finance";
import { listPlanVersions } from "@/server/services/planning";
import { createCounterparty } from "@/server/services/refs";
import { createTask } from "@/server/services/tasks";
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

const rub = (n: number) => n * 100;
const TODAY = new Date("2026-11-13T09:00:00Z");

async function finish(t: AssignedTrip) {
  for (const stop of t.trip.stops) {
    await recordEvent(t.logist, { tripId: t.tripId, type: stop.operation === "load" ? "loaded" : "unloaded", stopId: stop.id });
  }
}

async function customer(t: AssignedTrip, name = "ООО Ромашка") {
  const finance = await t.org.as("finance");
  const { id } = await createCounterparty(t.logist, { name, kind: "customer" });
  return { finance, customerId: id };
}

/** Plan figures of the trip as saved, so the tests do not depend on the synthetic route. */
async function planLine(t: AssignedTrip, category: string) {
  const [plan] = await listPlanVersions(t.logist, t.tripId);
  return plan.costLines.find((l) => l.category === category)!.kop!;
}

/** Everything a completed trip needs to be closed without an exception. */
async function completeTrip(t: AssignedTrip) {
  await finish(t);
  const finance = await t.org.as("finance");
  for (const stop of t.trip.stops.slice(1)) {
    await recordAcceptance(t.logist, { tripCargoId: stop.cargo[0].id, acceptedMilli: 5_000, rejectedMilli: 0, returnedMilli: 0 });
  }
  await setMileage(t.logist, { tripId: t.tripId, km: 23.7, unknown: false });
  const fuel = await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: await planLine(t, "fuel"), date: TODAY });
  const driver = await addExpense(finance, { tripId: t.tripId, category: "driver", amountKop: await planLine(t, "driver"), date: TODAY });
  await verifyExpense(finance, fuel.expenseId);
  await verifyExpense(finance, driver.expenseId);
  await markNotIncurred(finance, { tripId: t.tripId, category: "tolls" });
  return finance;
}

describe("expenses", () => {
  it("are tied to a trip, a vehicle or a document, and start unverified", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { expenseId } = await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: rub(3_000), date: TODAY, source: "чек АЗС" });
    const [expense] = await listExpenses(finance, { tripId: t.tripId });
    expect(expense).toMatchObject({ id: expenseId, category: "fuel", amountKop: rub(3_000), checkStatus: "unverified", notIncurred: false, source: "чек АЗС" });

    await verifyExpense(finance, expenseId);
    expect((await listExpenses(finance, { tripId: t.tripId }))[0].checkStatus).toBe("verified");
  });

  it("can be entered without a link and linked later", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { expenseId } = await addExpense(finance, { category: "other", amountKop: rub(500), date: TODAY });
    expect((await listExpenses(finance, { unlinked: true })).map((e) => e.id)).toEqual([expenseId]);
    await linkExpense(finance, { expenseId, tripId: t.tripId });
    expect(await listExpenses(finance, { unlinked: true })).toEqual([]);
    expect((await listExpenses(finance, { tripId: t.tripId }))[0].id).toBe(expenseId);
  });

  it("must be positive, and a marked-as-not-incurred line is replaced by a real one", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    await expectCode(addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: 0, date: TODAY }), "validation");
    await markNotIncurred(finance, { tripId: t.tripId, category: "tolls" });
    await markNotIncurred(finance, { tripId: t.tripId, category: "tolls" });
    expect(await listExpenses(finance, { tripId: t.tripId })).toHaveLength(1);

    await addExpense(finance, { tripId: t.tripId, category: "tolls", amountKop: rub(350), date: TODAY });
    const lines = await listExpenses(finance, { tripId: t.tripId });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amountKop: rub(350), notIncurred: false });
  });

  it("cannot be marked as not incurred when an amount already exists", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: rub(100), date: TODAY });
    await expectCode(markNotIncurred(finance, { tripId: t.tripId, category: "fuel" }), "expense_exists");
  });

  it("are refused for roles without money access and for other organizations", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(addExpense(await t.org.as("warehouse"), { tripId: t.tripId, category: "fuel", amountKop: 1, date: TODAY }), "forbidden");
    await expectCode(addExpense(await t.org.as("manager"), { tripId: t.tripId, category: "fuel", amountKop: 1, date: TODAY }), "forbidden");
    const other = await makeOrg(db);
    await expectCode(addExpense(await other.as("finance"), { tripId: t.tripId, category: "fuel", amountKop: 1, date: TODAY }), "not_found");
  });
});

describe("trip economics", () => {
  it("compares the baseline plan with the actual expenses and explains the deviation", async () => {
    const t = await makeAssignedTrip(db);
    await finish(t);
    const finance = await t.org.as("finance");
    const plannedFuel = await planLine(t, "fuel");
    const plannedDriver = await planLine(t, "driver");

    await addAccrual(finance, { tripId: t.tripId, kind: "revenue", description: "Доставка", amountKop: rub(100_000), vatIncluded: false });
    const fuel = await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: plannedFuel + rub(500), date: TODAY });
    await addExpense(finance, { tripId: t.tripId, category: "driver", amountKop: plannedDriver, date: TODAY });
    await markNotIncurred(finance, { tripId: t.tripId, category: "tolls" });
    await addExpense(finance, { tripId: t.tripId, category: "downtime", amountKop: rub(6_000), date: TODAY });

    const e = await getTripEconomics(finance, t.tripId);
    expect(e.basis).toBe("baseline");
    expect(e.result.plan.directKop).toBe(plannedFuel + plannedDriver);
    expect(e.result.fact.directKop).toBe(plannedFuel + rub(500) + plannedDriver + rub(6_000));
    expect(e.result.fact.marginKop).toBe(rub(100_000) - e.result.fact.directKop);
    expect(e.deviation.map((d) => [d.category, d.kop])).toEqual([["fuel", rub(500)], ["downtime", rub(6_000)]]);
    expect(e.deviation[0].expenseIds).toEqual([fuel.expenseId]);
    expect(e.deviation[1].expenseIds).toHaveLength(1);
    expect(e.unknownCategories).toEqual([]);
  });

  it("keeps a category unknown until its actual amount is entered", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: rub(1_000), date: TODAY });
    const e = await getTripEconomics(finance, t.tripId);
    expect(e.unknownCategories).toEqual(["driver", "tolls"]);
    expect(e.result.fact.incomplete).toBe(true);
    expect(e.result.fact.marginKop).toBeNull(); // no revenue yet
  });

  it("brings a carrier invoice with VAT to the net base", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    await addExpense(finance, { tripId: t.tripId, category: "carrier", amountKop: rub(50_020), vatIncluded: true, date: TODAY });
    const e = await getTripEconomics(finance, t.tripId);
    expect(e.expenses[0]).toMatchObject({ amountKop: rub(50_020), netKop: rub(41_000), vatIncluded: true });
    expect(e.result.fact.directKop).toBe(rub(41_000));
  });

  it("charges fleet overhead by the organization's rule", async () => {
    const t = await makeAssignedTrip(db);
    const admin = await t.org.as("admin");
    const { updateOrgSettings } = await import("@/server/services/users");
    await updateOrgSettings(admin, { fleetRule: "days", fleetRateKop: rub(1_800) });
    await finish(t);
    const finance = await t.org.as("finance");
    await addAccrual(finance, { tripId: t.tripId, kind: "revenue", description: "Доставка", amountKop: rub(50_000), vatIncluded: false });
    const e = await getTripEconomics(finance, t.tripId);
    expect(e.fleet).toEqual({ rule: "days", plan: rub(1_800), fact: rub(1_800) });
    expect(e.result.plan.afterFleetKop).toBe(e.result.plan.marginKop! - rub(1_800));

    await updateOrgSettings(admin, { fleetRule: "km", fleetRateKop: rub(15) });
    expect((await getTripEconomics(finance, t.tripId)).fleet.fact).toBeNull(); // mileage not entered
    await setMileage(t.logist, { tripId: t.tripId, km: 20, unknown: false });
    expect((await getTripEconomics(finance, t.tripId)).fleet.fact).toBe(rub(300));
  });

  it("allocates the delivery cost to orders by pallets and shows before and after", async () => {
    const t = await makeAssignedTrip(db);
    await finish(t);
    const finance = await t.org.as("finance");
    await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: 10_001, date: TODAY });

    const { delivery } = await getTripEconomics(finance, t.tripId);
    expect(delivery.allocationBase).toBe("pallets");
    expect(delivery.costSource).toBe("fact");
    expect(delivery.totalKop).toBe(10_001);
    expect(delivery.orders.map((o) => o.shareKop)).toEqual([5_001, 5_000]); // remainder to the first of equal shares
    expect(delivery.orders.reduce((s, o) => s + o.shareKop!, 0)).toBe(delivery.totalKop);
    expect(delivery.missing).toEqual([]);
  });

  it("says which orders cannot take a share when the base is missing", async () => {
    const t = await makeAssignedTrip(db);
    const { updateOrgSettings } = await import("@/server/services/users");
    await updateOrgSettings(await t.org.as("admin"), { deliveryAllocBase: "weight" });
    const finance = await t.org.as("finance");
    const { delivery } = await getTripEconomics(finance, t.tripId);
    expect(delivery.orders.every((o) => o.shareKop === null)).toBe(true);
    expect(delivery.missing).toHaveLength(2);
  });

  it("uses the plan cost for the allocation until actual expenses exist", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    const { delivery } = await getTripEconomics(finance, t.tripId);
    expect(delivery.costSource).toBe("plan");
    expect(delivery.totalKop).toBeGreaterThan(0);
  });

  it("is hidden from roles without money access and from other organizations", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(getTripEconomics(await t.org.as("warehouse"), t.tripId), "forbidden");
    await getTripEconomics(await t.org.as("manager"), t.tripId);
    await expectCode(getTripEconomics(await (await makeOrg(db)).as("finance"), t.tripId), "not_found");
  });
});

describe("invoices and payments", () => {
  it("a partial payment changes the debt and leaves the trip result alone", async () => {
    const t = await makeAssignedTrip(db);
    await finish(t);
    const { finance, customerId } = await customer(t);
    await addAccrual(finance, { tripId: t.tripId, kind: "revenue", description: "Доставка", amountKop: rub(112_000), vatIncluded: false });
    await addExpense(finance, { tripId: t.tripId, category: "fuel", amountKop: rub(3_000), date: TODAY });
    const { invoiceId } = await createInvoice(finance, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "15", date: TODAY, dueDate: new Date("2026-11-30T00:00:00Z"), amountKop: rub(112_000), vatIncluded: false });

    const before = await getTripEconomics(finance, t.tripId);
    const { paymentId } = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(80_000), purpose: "Оплата по счёту 15" });
    await allocatePayment(finance, { paymentId, invoiceId, amountKop: rub(80_000) });
    const after = await getTripEconomics(finance, t.tripId);

    expect(before.result).toEqual(after.result);
    expect(before.debt).toEqual({ receivableKop: rub(112_000), payableKop: 0 });
    expect(after.debt).toEqual({ receivableKop: rub(32_000), payableKop: 0 });
    const [invoice] = await listInvoices(finance, { tripId: t.tripId });
    expect(invoice).toMatchObject({ paidKop: rub(80_000), remainingKop: rub(32_000), state: "partially_paid" });
  });

  it("a payment that names one invoice waits for allocation and leaves the invoice unpaid", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    const { invoiceId } = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "21", date: TODAY, dueDate: TODAY, amountKop: rub(500), vatIncluded: true });
    const result = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(500), purpose: "Счёт 21" });

    expect(result.state).toBe("unallocated");
    expect(result.suggestions).toEqual([{ invoiceId, why: "number_in_purpose" }]);
    expect((await listInvoices(finance, {}))[0]).toMatchObject({ state: "unpaid", remainingKop: rub(500) });
  });

  it("a payment that fits two invoices needs review and closes nothing", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    for (const number of ["31", "32"]) {
      await createInvoice(finance, { direction: "out", counterpartyId: customerId, number, date: TODAY, dueDate: TODAY, amountKop: rub(700), vatIncluded: true });
    }
    const result = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(700), purpose: "Оплата за доставку" });

    expect(result.state).toBe("needs_review");
    expect(result.suggestions).toHaveLength(2);
    expect((await listInvoices(finance, {})).every((i) => i.state === "unpaid")).toBe(true);
    expect((await listPayments(finance, {}))[0]).toMatchObject({ state: "needs_review", remainingKop: rub(700) });
  });

  it("a payment that fits nothing also waits for a person", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    expect((await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(1), purpose: "Аванс" })).state).toBe("needs_review");
  });

  it("refuses to allocate more than the payment or the invoice allow", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    const { invoiceId } = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "41", date: TODAY, dueDate: TODAY, amountKop: rub(300), vatIncluded: true });
    const { paymentId } = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(1_000), purpose: "x" });

    await expectCode(allocatePayment(finance, { paymentId, invoiceId, amountKop: rub(301) }), "exceeds_invoice");
    await expectCode(allocatePayment(finance, { paymentId, invoiceId, amountKop: 0 }), "non_positive");
    await allocatePayment(finance, { paymentId, invoiceId, amountKop: rub(300) });
    const small = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(100), purpose: "y" });
    const second = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "42", date: TODAY, dueDate: TODAY, amountKop: rub(500), vatIncluded: true });
    await expectCode(allocatePayment(finance, { paymentId: small.paymentId, invoiceId: second.invoiceId, amountKop: rub(101) }), "exceeds_payment");
  });

  it("allocates one payment to two invoices and two payments to one invoice", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    const a = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "51", date: TODAY, dueDate: TODAY, amountKop: rub(400), vatIncluded: true });
    const b = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "52", date: TODAY, dueDate: TODAY, amountKop: rub(600), vatIncluded: true });

    const big = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: rub(1_000), purpose: "51 и 52" });
    await allocatePayment(finance, { paymentId: big.paymentId, invoiceId: a.invoiceId, amountKop: rub(400) });
    expect((await listPayments(finance, {}))[0].state).toBe("partially_allocated");
    await allocatePayment(finance, { paymentId: big.paymentId, invoiceId: b.invoiceId, amountKop: rub(600) });
    expect((await listPayments(finance, {}))[0]).toMatchObject({ state: "allocated", remainingKop: 0 });

    const c = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "53", date: TODAY, dueDate: TODAY, amountKop: rub(900), vatIncluded: true });
    for (const amount of [rub(500), rub(400)]) {
      const p = await recordPayment(finance, { direction: "in", counterpartyId: customerId, date: TODAY, amountKop: amount, purpose: "53" });
      await allocatePayment(finance, { paymentId: p.paymentId, invoiceId: c.invoiceId, amountKop: amount });
    }
    expect((await listInvoices(finance, {})).find((i) => i.id === c.invoiceId)).toMatchObject({ state: "paid", remainingKop: 0 });
  });

  it("matches a payment to an invoice of the same counterparty and direction only", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    const { id: otherId } = await createCounterparty(t.logist, { name: "ООО Колос", kind: "customer" });
    const { invoiceId } = await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "61", date: TODAY, dueDate: TODAY, amountKop: rub(300), vatIncluded: true });
    const stranger = await recordPayment(finance, { direction: "in", counterpartyId: otherId, date: TODAY, amountKop: rub(300), purpose: "61" });
    await expectCode(allocatePayment(finance, { paymentId: stranger.paymentId, invoiceId, amountKop: rub(300) }), "counterparty_mismatch");

    const outgoing = await recordPayment(finance, { direction: "out", counterpartyId: customerId, date: TODAY, amountKop: rub(300), purpose: "61" });
    await expectCode(allocatePayment(finance, { paymentId: outgoing.paymentId, invoiceId, amountKop: rub(300) }), "direction_mismatch");
  });

  it("marks an overdue invoice", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "71", date: new Date("2026-01-01T00:00:00Z"), dueDate: new Date("2026-01-15T00:00:00Z"), amountKop: rub(100), vatIncluded: true });
    await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "72", date: TODAY, dueDate: new Date("2099-01-01T00:00:00Z"), amountKop: rub(100), vatIncluded: true });
    const invoices = await listInvoices(finance, {});
    expect(invoices.find((i) => i.number === "71")!.overdue).toBe(true);
    expect(invoices.find((i) => i.number === "72")!.overdue).toBe(false);
  });

  it("refuses a duplicate invoice number for the same counterparty", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    const input = { direction: "out" as const, counterpartyId: customerId, number: "81", date: TODAY, dueDate: TODAY, amountKop: rub(100), vatIncluded: true };
    await createInvoice(finance, input);
    await expectCode(createInvoice(finance, input), "duplicate");
  });

  it("is isolated between organizations", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    await createInvoice(finance, { direction: "out", counterpartyId: customerId, number: "91", date: TODAY, dueDate: TODAY, amountKop: rub(100), vatIncluded: true });
    const other = await (await makeOrg(db)).as("finance");
    expect(await listInvoices(other, {})).toEqual([]);
    expect(await listPayments(other, {})).toEqual([]);
    await expectCode(createInvoice(other, { direction: "out", counterpartyId: customerId, number: "1", date: TODAY, dueDate: TODAY, amountKop: 1, vatIncluded: true }), "not_found");
  });
});

describe("surcharges", () => {
  it("are unbilled until they are put on an invoice", async () => {
    const t = await makeAssignedTrip(db);
    const { finance, customerId } = await customer(t);
    const { accrualId } = await addAccrual(finance, { tripId: t.tripId, kind: "surcharge", description: "Простой 3 ч", amountKop: rub(6_000), vatIncluded: false });
    expect((await getCompleteness(finance, t.tripId)).failed).toContain("unbilled_surcharge");

    await createInvoice(finance, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "S-1", date: TODAY, dueDate: TODAY, amountKop: rub(6_000), vatIncluded: false, accrualIds: [accrualId] });
    expect((await getCompleteness(finance, t.tripId)).failed).not.toContain("unbilled_surcharge");
    await expectCode(
      createInvoice(finance, { direction: "out", counterpartyId: customerId, tripId: t.tripId, number: "S-2", date: TODAY, dueDate: TODAY, amountKop: rub(6_000), vatIncluded: false, accrualIds: [accrualId] }),
      "accrual_billed",
    );
  });

  it("count in the actual result and not in the plan", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    await addAccrual(finance, { tripId: t.tripId, kind: "revenue", description: "Доставка", amountKop: rub(50_000), vatIncluded: false });
    const without = await getTripEconomics(finance, t.tripId);
    await addAccrual(finance, { tripId: t.tripId, kind: "surcharge", description: "Простой", amountKop: rub(6_000), vatIncluded: false });
    const withIt = await getTripEconomics(finance, t.tripId);
    expect(withIt.result.plan.marginKop).toBe(without.result.plan.marginKop);
    expect(withIt.result.fact.marginKop! - without.result.fact.marginKop!).toBe(rub(6_000));
  });
});

describe("documents", () => {
  it("are entered by hand and keep a log of status changes", async () => {
    const t = await makeAssignedTrip(db);
    const { documentId } = await addDocument(t.logist, { tripId: t.tripId, kind: "ЭПД", number: "ЭН-1", operatorRef: "diadoc:abc", status: "sent" });
    await setDocumentStatus(await t.org.as("finance"), { documentId, status: "signed" });

    const [doc] = await listDocuments(t.logist, t.tripId);
    expect(doc).toMatchObject({ kind: "ЭПД", number: "ЭН-1", operatorRef: "diadoc:abc", status: "signed" });
    expect(doc.log.map((l) => l.status)).toEqual(["sent", "signed"]);
  });

  it("are not available to roles that neither plan nor handle money", async () => {
    const t = await makeAssignedTrip(db);
    await expectCode(addDocument(await t.org.as("warehouse"), { tripId: t.tripId, kind: "ТН" }), "forbidden");
  });
});

describe("closing a trip", () => {
  it("is refused while data is incomplete, listing what is missing", async () => {
    const t = await makeAssignedTrip(db);
    await finish(t);
    const finance = await t.org.as("finance");
    const version = (await getTrip(finance, t.tripId)).version;

    const error = await expectCode(closeTrip(finance, { tripId: t.tripId, expectedVersion: version }), "incomplete");
    expect((error.details as { failed: string[] }).failed).toEqual(["acceptance_missing", "mileage_missing", "fact_expense_missing"]);
    expect((await getTrip(finance, t.tripId)).status).toBe("completed");
  });

  it("closes a complete trip without a reason, and then freezes its expenses", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await completeTrip(t);
    expect((await getCompleteness(finance, t.tripId)).ok).toBe(true);

    await closeTrip(finance, { tripId: t.tripId, expectedVersion: (await getTrip(finance, t.tripId)).version });
    const trip = await getTrip(finance, t.tripId);
    expect(trip.status).toBe("closed");
    expect(trip.closedAt).toBeInstanceOf(Date);
    expect(trip.closeOverrideReason).toBeNull();
    await expectCode(addExpense(finance, { tripId: t.tripId, category: "other", amountKop: 100, date: TODAY }), "trip_closed");
    await expectCode(addAccrual(finance, { tripId: t.tripId, kind: "surcharge", description: "поздно", amountKop: 100, vatIncluded: false }), "trip_closed");
  });

  it("closes with an exception, recording the reason and what was missing", async () => {
    const t = await makeAssignedTrip(db);
    await finish(t);
    const finance = await t.org.as("finance");
    await closeTrip(finance, { tripId: t.tripId, expectedVersion: (await getTrip(finance, t.tripId)).version, overrideReason: "Топливо подтвердим со сверкой в конце месяца" });

    const trip = await getTrip(finance, t.tripId);
    expect(trip).toMatchObject({ status: "closed", closeOverrideReason: "Топливо подтвердим со сверкой в конце месяца" });
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, t.tripId));
    const override = entries.find((e) => e.action === "close_override")!;
    expect(override.after).toMatchObject({ reason: "Топливо подтвердим со сверкой в конце месяца", failed: ["acceptance_missing", "mileage_missing", "fact_expense_missing"] });
  });

  it("does not accept a blank reason as an exception", async () => {
    const t = await makeAssignedTrip(db);
    await finish(t);
    const finance = await t.org.as("finance");
    await expectCode(closeTrip(finance, { tripId: t.tripId, expectedVersion: (await getTrip(finance, t.tripId)).version, overrideReason: "   " }), "incomplete");
  });

  it("counts unverified expenses and open tasks as incomplete", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await completeTrip(t);
    await addExpense(finance, { tripId: t.tripId, category: "other", amountKop: rub(100), date: TODAY });
    await createTask(t.logist, { type: "other", tripId: t.tripId, title: "Позвонить" });
    expect((await getCompleteness(finance, t.tripId)).failed).toEqual(["unverified_expense", "open_task"]);
  });

  it("is for the roles that may close, not the logistician or the manager", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await completeTrip(t);
    const version = (await getTrip(finance, t.tripId)).version;
    await expectCode(closeTrip(t.logist, { tripId: t.tripId, expectedVersion: version }), "forbidden");
    await expectCode(closeTrip(await t.org.as("manager"), { tripId: t.tripId, expectedVersion: version }), "forbidden");
    await closeTrip(await t.org.as("admin"), { tripId: t.tripId, expectedVersion: version });
  });

  it("cannot close a trip that is not completed", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await t.org.as("finance");
    await expectCode(closeTrip(finance, { tripId: t.tripId, expectedVersion: (await getTrip(finance, t.tripId)).version, overrideReason: "x" }), "invalid_transition");
  });

  it("rejects a stale version and another organization", async () => {
    const t = await makeAssignedTrip(db);
    const finance = await completeTrip(t);
    const version = (await getTrip(finance, t.tripId)).version;
    await expectCode(closeTrip(finance, { tripId: t.tripId, expectedVersion: version - 1 }), "stale");
    await expectCode(closeTrip(await (await makeOrg(db)).as("finance"), { tripId: t.tripId, expectedVersion: version }), "not_found");
  });
});
