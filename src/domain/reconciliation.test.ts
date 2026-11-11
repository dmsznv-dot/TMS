import { describe, expect, it } from "vitest";
import { checkPaymentAllocation, invoiceBalance, suggestInvoices } from "./reconciliation";

const rub = (n: number) => n * 100;

describe("invoiceBalance", () => {
  it("shows the debt left after a partial payment", () => {
    expect(invoiceBalance(rub(112_000), [rub(80_000)])).toEqual({ paidKop: rub(80_000), remainingKop: rub(32_000), state: "partially_paid" });
  });
  it("is unpaid without allocations and paid when covered", () => {
    expect(invoiceBalance(rub(100), [])).toEqual({ paidKop: 0, remainingKop: rub(100), state: "unpaid" });
    expect(invoiceBalance(rub(100), [rub(60), rub(40)])).toEqual({ paidKop: rub(100), remainingKop: 0, state: "paid" });
  });
  it("sums several payments", () => {
    expect(invoiceBalance(rub(100), [rub(10), rub(20)]).remainingKop).toBe(rub(70));
  });
});

describe("checkPaymentAllocation", () => {
  const base = { paymentKop: rub(100), alreadyAllocatedKop: rub(30), invoiceRemainingKop: rub(200), requestedKop: rub(50) };
  it("accepts an amount within the payment and the invoice", () => {
    expect(checkPaymentAllocation(base)).toEqual({ ok: true });
  });
  it("accepts exactly the remainder of the payment", () => {
    expect(checkPaymentAllocation({ ...base, requestedKop: rub(70) })).toEqual({ ok: true });
  });
  it("rejects more than is left of the payment", () => {
    expect(checkPaymentAllocation({ ...base, requestedKop: rub(71) })).toEqual({ ok: false, code: "exceeds_payment" });
  });
  it("rejects more than the invoice still owes", () => {
    expect(checkPaymentAllocation({ ...base, invoiceRemainingKop: rub(40) })).toEqual({ ok: false, code: "exceeds_invoice" });
  });
  it("rejects zero and negative amounts first", () => {
    expect(checkPaymentAllocation({ ...base, requestedKop: 0 })).toEqual({ ok: false, code: "non_positive" });
    expect(checkPaymentAllocation({ ...base, requestedKop: -1 })).toEqual({ ok: false, code: "non_positive" });
  });
});

describe("suggestInvoices", () => {
  const invoices = [
    { id: "i15", counterpartyId: "c1", number: "15", remainingKop: rub(500) },
    { id: "i115", counterpartyId: "c1", number: "115", remainingKop: rub(900) },
    { id: "i20", counterpartyId: "c1", number: "СЧ-20", remainingKop: rub(700) },
    { id: "x15", counterpartyId: "c2", number: "15", remainingKop: rub(500) },
  ];
  const payment = (purpose: string, amountKop: number) => ({ counterpartyId: "c1", amountKop, purpose });

  it("finds an invoice by its number in the purpose", () => {
    expect(suggestInvoices(payment("Оплата по счёту № 15 от 01.11.2026", rub(123)), invoices)).toEqual([{ invoiceId: "i15", why: "number_in_purpose" }]);
  });
  it("does not match a number inside a longer number", () => {
    expect(suggestInvoices(payment("Оплата счёта 115", rub(1)), invoices).map((s) => s.invoiceId)).toEqual(["i115"]);
  });
  it("matches numbers with letters regardless of case", () => {
    expect(suggestInvoices(payment("по сч-20", rub(1)), invoices).map((s) => s.invoiceId)).toEqual(["i20"]);
  });
  it("finds an invoice by the exact remaining amount", () => {
    expect(suggestInvoices(payment("Оплата за доставку", rub(700)), invoices)).toEqual([{ invoiceId: "i20", why: "exact_amount" }]);
  });
  it("calls a number match stronger than an amount match for the same invoice", () => {
    expect(suggestInvoices(payment("счёт 15", rub(500)), invoices)).toEqual([{ invoiceId: "i15", why: "number_in_purpose" }]);
  });
  it("offers every candidate when it is ambiguous, number matches first", () => {
    const list = [...invoices, { id: "i16", counterpartyId: "c1", number: "16", remainingKop: rub(500) }];
    expect(suggestInvoices(payment("счёт 16 или 15", rub(500)), list).map((s) => [s.invoiceId, s.why])).toEqual([
      ["i15", "number_in_purpose"],
      ["i16", "number_in_purpose"],
    ]);
    expect(suggestInvoices(payment("доставка", rub(500)), list).map((s) => s.invoiceId)).toEqual(["i15", "i16"]);
  });
  it("never suggests an invoice of another counterparty", () => {
    expect(suggestInvoices(payment("счёт 15", rub(500)), invoices).some((s) => s.invoiceId === "x15")).toBe(false);
  });
  it("suggests nothing when nothing fits", () => {
    expect(suggestInvoices(payment("аванс", rub(1)), invoices)).toEqual([]);
  });
  it("treats regular-expression characters in an invoice number as plain text", () => {
    const odd = [{ id: "o1", counterpartyId: "c1", number: "A+(1)", remainingKop: rub(1) }];
    expect(suggestInvoices(payment("по счёту A+(1) оплата", rub(5)), odd).map((s) => s.invoiceId)).toEqual(["o1"]);
    expect(suggestInvoices(payment("по счёту AAA1", rub(5)), odd)).toEqual([]);
  });
});
