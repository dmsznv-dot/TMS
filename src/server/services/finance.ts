import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { EXPENSE_LABELS, type ExpenseCategory } from "@/domain/costEstimate";
import { DomainError } from "@/domain/errors";
import { netKop } from "@/domain/money";
import { checkPaymentAllocation, invoiceBalance, suggestInvoices, type InvoiceState, type InvoiceSuggestion } from "@/domain/reconciliation";
import { allows, requireCan, type Ctx } from "../auth/context";
import {
  accruals,
  counterparties,
  documents,
  expenses,
  invoices,
  paymentAllocations,
  payments,
  trips,
  type DocumentLogEntry,
  type DocumentStatus,
} from "../db/schema";
import { audit, inTransaction } from "./audit";
import { isUniqueViolation } from "./dbErrors";
import { getOrgSettings } from "./users";
import { parseInput } from "./validation";

const CATEGORIES = Object.keys(EXPENSE_LABELS) as [ExpenseCategory, ...ExpenseCategory[]];
const money = z.number().int().positive("Сумма должна быть больше нуля");
const text = z.string().trim().min(1).optional();

/** A trip that can still take expenses and accruals: not closed, not cancelled. */
async function openTrip(ctx: Ctx, tripId: string): Promise<void> {
  const [trip] = await ctx.db.select({ status: trips.status }).from(trips).where(and(eq(trips.id, tripId), eq(trips.orgId, ctx.orgId)));
  if (!trip) throw new DomainError("not_found", "Рейс не найден");
  if (trip.status === "closed") throw new DomainError("trip_closed", "Рейс финансово закрыт: расходы и начисления в него не вносятся");
  if (trip.status === "cancelled") throw new DomainError("trip_locked", "Рейс отменён");
}

async function ownCounterparty(ctx: Ctx, id: string): Promise<void> {
  const [row] = await ctx.db.select({ id: counterparties.id }).from(counterparties).where(and(eq(counterparties.id, id), eq(counterparties.orgId, ctx.orgId)));
  if (!row) throw new DomainError("not_found", "Контрагент не найден");
}

// --- expenses ----------------------------------------------------------------

export const expenseInput = z.object({
  tripId: z.uuid().optional(),
  vehicleId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  category: z.enum(CATEGORIES),
  amountKop: money,
  vatIncluded: z.boolean().default(false),
  date: z.date(),
  source: text,
  isEstimate: z.boolean().default(false),
});

export type ExpenseView = {
  id: string;
  tripId: string | null;
  vehicleId: string | null;
  documentId: string | null;
  category: ExpenseCategory;
  amountKop: number;
  /** The amount without VAT: the base all calculations use. */
  netKop: number;
  vatIncluded: boolean;
  vatRateBp: number;
  date: Date;
  source: string | null;
  isEstimate: boolean;
  notIncurred: boolean;
  checkStatus: "unverified" | "verified";
};

const toExpenseView = (e: typeof expenses.$inferSelect): ExpenseView => ({
  id: e.id,
  tripId: e.tripId,
  vehicleId: e.vehicleId,
  documentId: e.documentId,
  category: e.category,
  amountKop: e.amountKop,
  netKop: netKop({ amountKop: e.amountKop, vatIncluded: e.vatIncluded, vatRateBp: e.vatRateBp }),
  vatIncluded: e.vatIncluded,
  vatRateBp: e.vatRateBp,
  date: e.date,
  source: e.source,
  isEstimate: e.isEstimate,
  notIncurred: e.notIncurred,
  checkStatus: e.checkStatus,
});

/** Records an actual expense. It replaces a "did not occur" mark for the same category of the trip. */
export async function addExpense(ctx: Ctx, input: z.input<typeof expenseInput>): Promise<{ expenseId: string }> {
  const actor = requireCan(ctx, "money.write");
  const data = parseInput(expenseInput, input);
  return inTransaction(ctx, async (tx) => {
    if (data.tripId) {
      await openTrip(tx, data.tripId);
      await tx.db
        .delete(expenses)
        .where(and(eq(expenses.tripId, data.tripId), eq(expenses.orgId, tx.orgId), eq(expenses.category, data.category), eq(expenses.notIncurred, true)));
    }
    const settings = await getOrgSettings(tx);
    const [row] = await tx.db
      .insert(expenses)
      .values({
        orgId: tx.orgId,
        tripId: data.tripId ?? null,
        vehicleId: data.vehicleId ?? null,
        documentId: data.documentId ?? null,
        category: data.category,
        amountKop: data.amountKop,
        vatIncluded: data.vatIncluded,
        vatRateBp: settings.vatRateBp,
        date: data.date,
        source: data.source ?? null,
        isEstimate: data.isEstimate,
        createdBy: actor.userId,
      })
      .returning({ id: expenses.id });
    await audit(tx, { entity: "expense", entityId: row.id, action: "create", after: { tripId: data.tripId, category: data.category, amountKop: data.amountKop } });
    return { expenseId: row.id };
  });
}

export async function verifyExpense(ctx: Ctx, expenseId: string): Promise<void> {
  requireCan(ctx, "money.write");
  await inTransaction(ctx, async (tx) => {
    const [row] = await tx.db.select().from(expenses).where(and(eq(expenses.id, expenseId), eq(expenses.orgId, tx.orgId)));
    if (!row) throw new DomainError("not_found", "Расход не найден");
    if (row.tripId) await openTrip(tx, row.tripId);
    await tx.db.update(expenses).set({ checkStatus: "verified" }).where(eq(expenses.id, expenseId));
    await audit(tx, { entity: "expense", entityId: expenseId, action: "verify" });
  });
}

/** States that an expense category of the trip did not occur: a verified zero line. */
export async function markNotIncurred(ctx: Ctx, input: { tripId: string; category: ExpenseCategory }): Promise<void> {
  const actor = requireCan(ctx, "money.write");
  const data = parseInput(z.object({ tripId: z.uuid(), category: z.enum(CATEGORIES) }), input);
  await inTransaction(ctx, async (tx) => {
    await openTrip(tx, data.tripId);
    const existing = await tx.db
      .select({ notIncurred: expenses.notIncurred })
      .from(expenses)
      .where(and(eq(expenses.tripId, data.tripId), eq(expenses.orgId, tx.orgId), eq(expenses.category, data.category)));
    if (existing.some((e) => !e.notIncurred)) throw new DomainError("expense_exists", "По этой статье уже внесена сумма");
    if (existing.length > 0) return;
    const settings = await getOrgSettings(tx);
    const [row] = await tx.db
      .insert(expenses)
      .values({
        orgId: tx.orgId,
        tripId: data.tripId,
        category: data.category,
        amountKop: 0,
        vatIncluded: false,
        vatRateBp: settings.vatRateBp,
        date: new Date(),
        source: "отметка «не было»",
        notIncurred: true,
        checkStatus: "verified",
        createdBy: actor.userId,
      })
      .returning({ id: expenses.id });
    await audit(tx, { entity: "expense", entityId: row.id, action: "not_incurred", after: data });
  });
}

/** Ties an expense that was entered without a trip to one. */
export async function linkExpense(ctx: Ctx, input: { expenseId: string; tripId: string }): Promise<void> {
  requireCan(ctx, "money.write");
  await inTransaction(ctx, async (tx) => {
    await openTrip(tx, input.tripId);
    const updated = await tx.db
      .update(expenses)
      .set({ tripId: input.tripId })
      .where(and(eq(expenses.id, input.expenseId), eq(expenses.orgId, tx.orgId)))
      .returning({ id: expenses.id });
    if (updated.length === 0) throw new DomainError("not_found", "Расход не найден");
    await audit(tx, { entity: "expense", entityId: input.expenseId, action: "link", after: { tripId: input.tripId } });
  });
}

export async function listExpenses(ctx: Ctx, filter: { tripId?: string; unlinked?: boolean } = {}): Promise<ExpenseView[]> {
  requireCan(ctx, "money.read");
  const conditions = [eq(expenses.orgId, ctx.orgId)];
  if (filter.tripId) conditions.push(eq(expenses.tripId, filter.tripId));
  if (filter.unlinked) conditions.push(isNull(expenses.tripId), isNull(expenses.vehicleId), isNull(expenses.documentId));
  const rows = await ctx.db.select().from(expenses).where(and(...conditions)).orderBy(asc(expenses.date), asc(expenses.createdAt));
  return rows.map(toExpenseView);
}

// --- accruals and invoices ---------------------------------------------------

export const accrualInput = z.object({
  tripId: z.uuid(),
  kind: z.enum(["revenue", "surcharge"]),
  description: z.string().trim().min(1, "Опишите начисление"),
  amountKop: money,
  vatIncluded: z.boolean().default(false),
});

export async function addAccrual(ctx: Ctx, input: z.input<typeof accrualInput>): Promise<{ accrualId: string }> {
  requireCan(ctx, "money.write");
  const data = parseInput(accrualInput, input);
  return inTransaction(ctx, async (tx) => {
    await openTrip(tx, data.tripId);
    const settings = await getOrgSettings(tx);
    const [row] = await tx.db
      .insert(accruals)
      .values({ orgId: tx.orgId, ...data, vatRateBp: settings.vatRateBp })
      .returning({ id: accruals.id });
    await audit(tx, { entity: "accrual", entityId: row.id, action: "create", after: { kind: data.kind, amountKop: data.amountKop } });
    return { accrualId: row.id };
  });
}

export const invoiceInput = z.object({
  direction: z.enum(["out", "in"]),
  counterpartyId: z.uuid(),
  tripId: z.uuid().optional(),
  number: z.string().trim().min(1, "Укажите номер счёта"),
  date: z.date(),
  dueDate: z.date(),
  amountKop: money,
  vatIncluded: z.boolean().default(true),
  accrualIds: z.array(z.uuid()).optional(),
});

export async function createInvoice(ctx: Ctx, input: z.input<typeof invoiceInput>): Promise<{ invoiceId: string }> {
  requireCan(ctx, "money.write");
  const data = parseInput(invoiceInput, input);
  return inTransaction(ctx, async (tx) => {
    await ownCounterparty(tx, data.counterpartyId);
    if (data.tripId) {
      const [trip] = await tx.db.select({ id: trips.id }).from(trips).where(and(eq(trips.id, data.tripId), eq(trips.orgId, tx.orgId)));
      if (!trip) throw new DomainError("not_found", "Рейс не найден");
    }

    const accrualRows = data.accrualIds?.length
      ? await tx.db.select().from(accruals).where(and(eq(accruals.orgId, tx.orgId), inArray(accruals.id, data.accrualIds))).for("update")
      : [];
    if (accrualRows.length !== (data.accrualIds?.length ?? 0)) throw new DomainError("not_found", "Начисление не найдено");
    if (accrualRows.some((a) => a.state === "invoiced")) throw new DomainError("accrual_billed", "Начисление уже выставлено в другом счёте");

    const settings = await getOrgSettings(tx);
    let row: { id: string };
    try {
      [row] = await tx.db
        .insert(invoices)
        .values({
          orgId: tx.orgId,
          direction: data.direction,
          counterpartyId: data.counterpartyId,
          tripId: data.tripId ?? null,
          number: data.number,
          date: data.date,
          dueDate: data.dueDate,
          amountKop: data.amountKop,
          vatIncluded: data.vatIncluded,
          vatRateBp: settings.vatRateBp,
        })
        .returning({ id: invoices.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("duplicate", "Счёт с таким номером для этого контрагента уже есть");
      throw e;
    }
    if (accrualRows.length > 0) {
      await tx.db.update(accruals).set({ state: "invoiced", invoiceId: row.id }).where(inArray(accruals.id, accrualRows.map((a) => a.id)));
    }
    await audit(tx, { entity: "invoice", entityId: row.id, action: "create", after: { number: data.number, amountKop: data.amountKop } });
    return { invoiceId: row.id };
  });
}

export type InvoiceView = {
  id: string;
  direction: "out" | "in";
  counterpartyId: string;
  counterpartyName: string;
  tripId: string | null;
  number: string;
  date: Date;
  dueDate: Date;
  amountKop: number;
  vatIncluded: boolean;
  paidKop: number;
  remainingKop: number;
  state: InvoiceState;
  overdue: boolean;
};

async function allocationsByInvoice(ctx: Ctx, invoiceIds: string[]): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (invoiceIds.length === 0) return map;
  const rows = await ctx.db
    .select({ invoiceId: paymentAllocations.invoiceId, amountKop: paymentAllocations.amountKop })
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.orgId, ctx.orgId), inArray(paymentAllocations.invoiceId, invoiceIds)));
  for (const r of rows) map.set(r.invoiceId, [...(map.get(r.invoiceId) ?? []), r.amountKop]);
  return map;
}

export async function listInvoices(
  ctx: Ctx,
  filter: { direction?: "out" | "in"; tripId?: string; openOnly?: boolean } = {},
): Promise<InvoiceView[]> {
  requireCan(ctx, "money.read");
  const conditions = [eq(invoices.orgId, ctx.orgId)];
  if (filter.direction) conditions.push(eq(invoices.direction, filter.direction));
  if (filter.tripId) conditions.push(eq(invoices.tripId, filter.tripId));
  const rows = await ctx.db
    .select({ invoice: invoices, counterpartyName: counterparties.name })
    .from(invoices)
    .innerJoin(counterparties, eq(counterparties.id, invoices.counterpartyId))
    .where(and(...conditions))
    .orderBy(desc(invoices.date), desc(invoices.number));

  const allocations = await allocationsByInvoice(ctx, rows.map((r) => r.invoice.id));
  const now = Date.now();
  const views = rows.map(({ invoice, counterpartyName }): InvoiceView => {
    const balance = invoiceBalance(invoice.amountKop, allocations.get(invoice.id) ?? []);
    return {
      id: invoice.id,
      direction: invoice.direction,
      counterpartyId: invoice.counterpartyId,
      counterpartyName,
      tripId: invoice.tripId,
      number: invoice.number,
      date: invoice.date,
      dueDate: invoice.dueDate,
      amountKop: invoice.amountKop,
      vatIncluded: invoice.vatIncluded,
      ...balance,
      overdue: balance.remainingKop > 0 && invoice.dueDate.getTime() < now,
    };
  });
  return filter.openOnly ? views.filter((v) => v.remainingKop > 0) : views;
}

// --- payments ----------------------------------------------------------------

export const paymentInput = z.object({
  direction: z.enum(["in", "out"]),
  counterpartyId: z.uuid(),
  date: z.date(),
  amountKop: money,
  purpose: z.string().trim().default(""),
});

/**
 * Records a payment. It is never allocated automatically: with exactly one
 * likely invoice it waits as "unallocated" for a click, otherwise it needs a review.
 */
export async function recordPayment(
  ctx: Ctx,
  input: z.input<typeof paymentInput>,
): Promise<{ paymentId: string; state: "unallocated" | "needs_review"; suggestions: InvoiceSuggestion[] }> {
  requireCan(ctx, "money.write");
  const data = parseInput(paymentInput, input);
  return inTransaction(ctx, async (tx) => {
    await ownCounterparty(tx, data.counterpartyId);
    const open = (await listInvoices(tx, { direction: data.direction === "in" ? "out" : "in", openOnly: true })).map((i) => ({
      id: i.id,
      counterpartyId: i.counterpartyId,
      number: i.number,
      remainingKop: i.remainingKop,
    }));
    const suggestions = suggestInvoices({ counterpartyId: data.counterpartyId, amountKop: data.amountKop, purpose: data.purpose }, open);
    const state = suggestions.length === 1 ? "unallocated" : "needs_review";
    const [row] = await tx.db
      .insert(payments)
      .values({ orgId: tx.orgId, direction: data.direction, counterpartyId: data.counterpartyId, date: data.date, amountKop: data.amountKop, purpose: data.purpose, state })
      .returning({ id: payments.id });
    await audit(tx, { entity: "payment", entityId: row.id, action: "create", after: { amountKop: data.amountKop, state } });
    return { paymentId: row.id, state, suggestions };
  });
}

/** Puts part or all of a payment against one invoice. A person does this; nothing else does. */
export async function allocatePayment(ctx: Ctx, input: { paymentId: string; invoiceId: string; amountKop: number }): Promise<void> {
  const actor = requireCan(ctx, "money.write");
  await inTransaction(ctx, async (tx) => {
    const [payment] = await tx.db.select().from(payments).where(and(eq(payments.id, input.paymentId), eq(payments.orgId, tx.orgId))).for("update");
    const [invoice] = await tx.db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, tx.orgId))).for("update");
    if (!payment) throw new DomainError("not_found", "Платёж не найден");
    if (!invoice) throw new DomainError("not_found", "Счёт не найден");
    if (payment.counterpartyId !== invoice.counterpartyId) throw new DomainError("counterparty_mismatch", "Платёж и счёт относятся к разным контрагентам");
    if ((payment.direction === "in") !== (invoice.direction === "out")) throw new DomainError("direction_mismatch", "Входящий платёж гасит исходящий счёт, исходящий — входящий");

    const [{ allocated }] = await tx.db
      .select({ allocated: sql<number>`coalesce(sum(${paymentAllocations.amountKop}), 0)::float8` })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, payment.id));
    const invoiceAllocations = (await allocationsByInvoice(tx, [invoice.id])).get(invoice.id) ?? [];

    const check = checkPaymentAllocation({
      paymentKop: payment.amountKop,
      alreadyAllocatedKop: Number(allocated),
      invoiceRemainingKop: invoiceBalance(invoice.amountKop, invoiceAllocations).remainingKop,
      requestedKop: input.amountKop,
    });
    if (!check.ok) {
      const messages = {
        non_positive: "Сумма должна быть больше нуля",
        exceeds_payment: "Сумма больше неразнесённого остатка платежа",
        exceeds_invoice: "Сумма больше остатка по счёту",
      } as const;
      throw new DomainError(check.code, messages[check.code]);
    }

    await tx.db.insert(paymentAllocations).values({ orgId: tx.orgId, paymentId: payment.id, invoiceId: invoice.id, amountKop: input.amountKop, createdBy: actor.userId });
    const total = Number(allocated) + input.amountKop;
    await tx.db.update(payments).set({ state: total >= payment.amountKop ? "allocated" : "partially_allocated" }).where(eq(payments.id, payment.id));
    await audit(tx, { entity: "payment", entityId: payment.id, action: "allocate", after: { invoiceId: invoice.id, amountKop: input.amountKop } });
  });
}

export type PaymentView = {
  id: string;
  direction: "in" | "out";
  counterpartyId: string;
  counterpartyName: string;
  date: Date;
  amountKop: number;
  purpose: string;
  state: "unallocated" | "needs_review" | "partially_allocated" | "allocated";
  allocatedKop: number;
  remainingKop: number;
};

export async function listPayments(ctx: Ctx, filter: { direction?: "in" | "out" } = {}): Promise<PaymentView[]> {
  requireCan(ctx, "money.read");
  const conditions = [eq(payments.orgId, ctx.orgId)];
  if (filter.direction) conditions.push(eq(payments.direction, filter.direction));
  const rows = await ctx.db
    .select({
      payment: payments,
      counterpartyName: counterparties.name,
      allocated: sql<number>`coalesce((select sum(amount_kop) from payment_allocation pa where pa.payment_id = ${payments.id}), 0)::float8`,
    })
    .from(payments)
    .innerJoin(counterparties, eq(counterparties.id, payments.counterpartyId))
    .where(and(...conditions))
    .orderBy(desc(payments.date), desc(payments.createdAt));
  return rows.map(({ payment, counterpartyName, allocated }) => ({
    id: payment.id,
    direction: payment.direction,
    counterpartyId: payment.counterpartyId,
    counterpartyName,
    date: payment.date,
    amountKop: payment.amountKop,
    purpose: payment.purpose,
    state: payment.state,
    allocatedKop: Number(allocated),
    remainingKop: payment.amountKop - Number(allocated),
  }));
}

// --- documents ---------------------------------------------------------------

export const documentInput = z.object({
  tripId: z.uuid(),
  kind: z.string().trim().min(1, "Укажите вид документа"),
  number: text,
  operatorRef: text,
  status: z.enum(["draft", "sent", "signed", "rejected"]).default("draft"),
});

/** Documents come from planning and from billing, so either permission is enough. */
function requireDocumentWriter(ctx: Ctx) {
  if (!allows(ctx, "planning.write") && !allows(ctx, "money.write")) return requireCan(ctx, "planning.write");
  return ctx.actor.kind === "user" ? ctx.actor : requireCan(ctx, "planning.write");
}

export async function addDocument(ctx: Ctx, input: z.input<typeof documentInput>): Promise<{ documentId: string }> {
  const actor = requireDocumentWriter(ctx);
  const data = parseInput(documentInput, input);
  return inTransaction(ctx, async (tx) => {
    const [trip] = await tx.db.select({ id: trips.id }).from(trips).where(and(eq(trips.id, data.tripId), eq(trips.orgId, tx.orgId)));
    if (!trip) throw new DomainError("not_found", "Рейс не найден");
    const log: DocumentLogEntry[] = [{ at: new Date().toISOString(), status: data.status, by: actor.userId }];
    const [row] = await tx.db
      .insert(documents)
      .values({ orgId: tx.orgId, tripId: data.tripId, kind: data.kind, number: data.number ?? null, operatorRef: data.operatorRef ?? null, status: data.status, log })
      .returning({ id: documents.id });
    await audit(tx, { entity: "document", entityId: row.id, action: "create", after: { kind: data.kind, status: data.status } });
    return { documentId: row.id };
  });
}

export async function setDocumentStatus(ctx: Ctx, input: { documentId: string; status: DocumentStatus }): Promise<void> {
  const actor = requireDocumentWriter(ctx);
  const status = parseInput(z.enum(["draft", "sent", "signed", "rejected"]), input.status);
  await inTransaction(ctx, async (tx) => {
    const [doc] = await tx.db.select().from(documents).where(and(eq(documents.id, input.documentId), eq(documents.orgId, tx.orgId))).for("update");
    if (!doc) throw new DomainError("not_found", "Документ не найден");
    const log = [...doc.log, { at: new Date().toISOString(), status, by: actor.userId }];
    await tx.db.update(documents).set({ status, log }).where(eq(documents.id, doc.id));
    await audit(tx, { entity: "document", entityId: doc.id, action: "status", before: { status: doc.status }, after: { status } });
  });
}

export type DocumentView = {
  id: string;
  tripId: string;
  kind: string;
  number: string | null;
  operatorRef: string | null;
  status: DocumentStatus;
  log: DocumentLogEntry[];
};

export async function listDocuments(ctx: Ctx, tripId: string): Promise<DocumentView[]> {
  requireCan(ctx, "trips.read");
  const rows = await ctx.db
    .select()
    .from(documents)
    .where(and(eq(documents.tripId, tripId), eq(documents.orgId, ctx.orgId)))
    .orderBy(asc(documents.createdAt));
  return rows.map((d) => ({ id: d.id, tripId: d.tripId, kind: d.kind, number: d.number, operatorRef: d.operatorRef, status: d.status, log: d.log }));
}

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Черновик",
  sent: "Отправлен",
  signed: "Подписан",
  rejected: "Отклонён",
};
