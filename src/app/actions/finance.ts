"use server";

import type { ExpenseCategory } from "@/domain/costEstimate";
import { closeTrip } from "@/server/services/close";
import {
  addAccrual,
  addDocument,
  addExpense,
  allocatePayment,
  createInvoice,
  linkExpense,
  markNotIncurred,
  recordPayment,
  setDocumentStatus,
  verifyExpense,
} from "@/server/services/finance";
import type { DocumentStatus } from "@/server/db/schema";
import { run, type ActionResult } from "./run";

const trip = (tripId: string) => [`/trips/${tripId}`, "/trips", "/money"];

export async function addAccrualAction(
  tripId: string,
  input: { kind: "revenue" | "surcharge"; description: string; amountKop: number; vatIncluded: boolean },
): Promise<ActionResult<{ accrualId: string }>> {
  return run((ctx) => addAccrual(ctx, { tripId, ...input }), trip(tripId));
}

export async function addExpenseAction(
  tripId: string,
  input: { category: ExpenseCategory; amountKop: number; vatIncluded: boolean; date: Date; source?: string; isEstimate: boolean },
): Promise<ActionResult<{ expenseId: string }>> {
  return run((ctx) => addExpense(ctx, { tripId, ...input }), trip(tripId));
}

export async function verifyExpenseAction(tripId: string, expenseId: string): Promise<ActionResult> {
  return run((ctx) => verifyExpense(ctx, expenseId), trip(tripId));
}

export async function markNotIncurredAction(tripId: string, category: ExpenseCategory): Promise<ActionResult> {
  return run((ctx) => markNotIncurred(ctx, { tripId, category }), trip(tripId));
}

export async function createInvoiceAction(
  tripId: string,
  input: {
    direction: "out" | "in";
    counterpartyId: string;
    number: string;
    date: Date;
    dueDate: Date;
    amountKop: number;
    vatIncluded: boolean;
    accrualIds: string[];
  },
): Promise<ActionResult<{ invoiceId: string }>> {
  return run((ctx) => createInvoice(ctx, { tripId, ...input, accrualIds: input.accrualIds.length > 0 ? input.accrualIds : undefined }), trip(tripId));
}

export async function closeTripAction(tripId: string, expectedVersion: number, overrideReason: string): Promise<ActionResult<{ version: number }>> {
  return run((ctx) => closeTrip(ctx, { tripId, expectedVersion, overrideReason }), trip(tripId));
}

export async function addDocumentAction(
  tripId: string,
  input: { kind: string; number?: string; operatorRef?: string; status: DocumentStatus },
): Promise<ActionResult<{ documentId: string }>> {
  return run((ctx) => addDocument(ctx, { tripId, ...input }), trip(tripId));
}

export async function setDocumentStatusAction(tripId: string, documentId: string, status: DocumentStatus): Promise<ActionResult> {
  return run((ctx) => setDocumentStatus(ctx, { documentId, status }), trip(tripId));
}

export async function recordPaymentAction(input: {
  direction: "in" | "out";
  counterpartyId: string;
  date: Date;
  amountKop: number;
  purpose: string;
}): Promise<ActionResult<{ paymentId: string; state: "unallocated" | "needs_review" }>> {
  return run((ctx) => recordPayment(ctx, input), ["/money"]);
}

export async function allocatePaymentAction(paymentId: string, invoiceId: string, amountKop: number): Promise<ActionResult> {
  return run((ctx) => allocatePayment(ctx, { paymentId, invoiceId, amountKop }), ["/money", "/trips"]);
}

export async function linkExpenseAction(expenseId: string, tripId: string): Promise<ActionResult> {
  return run((ctx) => linkExpense(ctx, { expenseId, tripId }), ["/money", `/trips/${tripId}`]);
}
