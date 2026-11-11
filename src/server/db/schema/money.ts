import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { ExpenseCategory } from "@/domain/costEstimate";
import { organizations, users } from "./org";
import { counterparties, vehicles } from "./refs";
import { trips } from "./trips";

/**
 * Actual expenses. Plan figures live in the plan version, not here. A line with
 * not_incurred set and a zero amount is the mark "this expense did not occur".
 */
export const expenses = pgTable(
  "expense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    tripId: uuid("trip_id").references(() => trips.id),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    /** Document the expense comes from; a plain reference until documents are linked here. */
    documentId: uuid("document_id"),
    category: text("category").$type<ExpenseCategory>().notNull(),
    amountKop: bigint("amount_kop", { mode: "number" }).notNull(),
    vatIncluded: boolean("vat_included").notNull().default(false),
    vatRateBp: integer("vat_rate_bp").notNull(),
    date: timestamp("date", { withTimezone: true }).notNull(),
    source: text("source"),
    /** The amount comes from a norm or a rate, not from a document. */
    isEstimate: boolean("is_estimate").notNull().default(false),
    notIncurred: boolean("not_incurred").notNull().default(false),
    checkStatus: text("check_status").$type<"unverified" | "verified">().notNull().default("unverified"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("expense_trip_idx").on(t.tripId)],
);

export const accruals = pgTable(
  "accrual",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    kind: text("kind").$type<"revenue" | "surcharge">().notNull(),
    description: text("description").notNull(),
    amountKop: bigint("amount_kop", { mode: "number" }).notNull(),
    vatIncluded: boolean("vat_included").notNull().default(false),
    vatRateBp: integer("vat_rate_bp").notNull(),
    /** agreed: owed but not yet on an invoice; invoiced: put on an invoice. */
    state: text("state").$type<"agreed" | "invoiced">().notNull().default("agreed"),
    invoiceId: uuid("invoice_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("accrual_trip_idx").on(t.tripId)],
);

export const invoices = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    /** out: issued to a customer; in: received from a carrier. */
    direction: text("direction").$type<"out" | "in">().notNull(),
    counterpartyId: uuid("counterparty_id").notNull().references(() => counterparties.id),
    tripId: uuid("trip_id").references(() => trips.id),
    number: text("number").notNull(),
    date: timestamp("date", { withTimezone: true }).notNull(),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    amountKop: bigint("amount_kop", { mode: "number" }).notNull(),
    vatIncluded: boolean("vat_included").notNull().default(true),
    vatRateBp: integer("vat_rate_bp").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("invoice_number").on(t.orgId, t.direction, t.counterpartyId, t.number), index("invoice_trip_idx").on(t.tripId)],
);

export const payments = pgTable("payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  /** in: money received; out: money paid. */
  direction: text("direction").$type<"in" | "out">().notNull(),
  counterpartyId: uuid("counterparty_id").notNull().references(() => counterparties.id),
  date: timestamp("date", { withTimezone: true }).notNull(),
  amountKop: bigint("amount_kop", { mode: "number" }).notNull(),
  purpose: text("purpose").notNull().default(""),
  state: text("state").$type<"unallocated" | "needs_review" | "partially_allocated" | "allocated">().notNull().default("unallocated"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paymentAllocations = pgTable(
  "payment_allocation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    paymentId: uuid("payment_id").notNull().references(() => payments.id),
    invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
    amountKop: bigint("amount_kop", { mode: "number" }).notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payment_allocation_invoice_idx").on(t.invoiceId), index("payment_allocation_payment_idx").on(t.paymentId)],
);

export type DocumentStatus = "draft" | "sent" | "signed" | "rejected";
export type DocumentLogEntry = { at: string; status: DocumentStatus; by: string };

export const documents = pgTable(
  "document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    kind: text("kind").notNull(),
    number: text("number"),
    /** Identifier or link at the document operator. */
    operatorRef: text("operator_ref"),
    status: text("status").$type<DocumentStatus>().notNull().default("draft"),
    log: jsonb("log").$type<DocumentLogEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_trip_idx").on(t.tripId)],
);
