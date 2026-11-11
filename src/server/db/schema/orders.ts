import { bigint, boolean, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./org";
import { counterparties, locations } from "./refs";

export const orders = pgTable(
  "sales_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    /** Number of the order in the system it came from. */
    number: text("number").notNull(),
    /** Where the order came from: "manual" or "template:<id>". */
    source: text("source").notNull(),
    customerId: uuid("customer_id").references(() => counterparties.id),
    customerName: text("customer_name"),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    cancelled: boolean("cancelled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("sales_order_key").on(t.orgId, t.source, t.number)],
);

export const orderLines = pgTable(
  "order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    orderId: uuid("order_id").notNull().references(() => orders.id),
    /** Identifies the line within its order across repeated imports. */
    lineKey: text("line_key").notNull(),
    product: text("product"),
    unit: text("unit"),
    qtyMilli: bigint("qty_milli", { mode: "number" }).notNull(),
    /** Totals for the whole line, in thousandths. */
    weightKgMilli: bigint("weight_kg_milli", { mode: "number" }),
    volumeM3Milli: bigint("volume_m3_milli", { mode: "number" }),
    palletsMilli: bigint("pallets_milli", { mode: "number" }),
    /** Selling price and cost of goods per unit, in kopecks. */
    priceKop: bigint("price_kop", { mode: "number" }),
    costKop: bigint("cost_kop", { mode: "number" }),
  },
  (t) => [unique("order_line_key").on(t.orderId, t.lineKey), index("order_line_order_idx").on(t.orderId)],
);
