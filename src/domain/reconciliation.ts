export type InvoiceState = "unpaid" | "partially_paid" | "paid";

/** What has been paid on an invoice and what is still owed. Payments do not change the trip result. */
export function invoiceBalance(amountKop: number, allocationsKop: number[]): { paidKop: number; remainingKop: number; state: InvoiceState } {
  const paidKop = allocationsKop.reduce((s, a) => s + a, 0);
  const state: InvoiceState = paidKop <= 0 ? "unpaid" : paidKop >= amountKop ? "paid" : "partially_paid";
  return { paidKop, remainingKop: amountKop - paidKop, state };
}

export type AllocationCheck = { ok: true } | { ok: false; code: "non_positive" | "exceeds_payment" | "exceeds_invoice" };

export function checkPaymentAllocation(i: {
  paymentKop: number;
  alreadyAllocatedKop: number;
  invoiceRemainingKop: number;
  requestedKop: number;
}): AllocationCheck {
  if (i.requestedKop <= 0) return { ok: false, code: "non_positive" };
  if (i.requestedKop > i.paymentKop - i.alreadyAllocatedKop) return { ok: false, code: "exceeds_payment" };
  if (i.requestedKop > i.invoiceRemainingKop) return { ok: false, code: "exceeds_invoice" };
  return { ok: true };
}

export type InvoiceSuggestion = { invoiceId: string; why: "number_in_purpose" | "exact_amount" };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the number stands in the text as a whole token, not inside a longer number or word. */
function mentions(purpose: string, number: string): boolean {
  if (!number.trim()) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(number.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(purpose);
}

/**
 * Invoices of the payer that a payment may belong to: those named in its
 * purpose first, then those whose remaining amount equals the payment. More
 * than one suggestion means a person must decide.
 */
export function suggestInvoices(
  payment: { counterpartyId: string; amountKop: number; purpose: string },
  open: { id: string; counterpartyId: string; number: string; remainingKop: number }[],
): InvoiceSuggestion[] {
  const own = open.filter((inv) => inv.counterpartyId === payment.counterpartyId);
  const byNumber = own.filter((inv) => mentions(payment.purpose, inv.number)).map((inv): InvoiceSuggestion => ({ invoiceId: inv.id, why: "number_in_purpose" }));
  const named = new Set(byNumber.map((s) => s.invoiceId));
  const byAmount = own
    .filter((inv) => !named.has(inv.id) && inv.remainingKop === payment.amountKop)
    .map((inv): InvoiceSuggestion => ({ invoiceId: inv.id, why: "exact_amount" }));
  return [...byNumber, ...byAmount];
}
