import { bigint, boolean, doublePrecision, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { TripStatus } from "@/domain/tripStatus";
import { orderLines } from "./orders";
import { organizations } from "./org";
import { locations } from "./refs";

export const trips = pgTable(
  "trip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    number: text("number").notNull(),
    status: text("status").$type<TripStatus>().notNull().default("draft"),
    /** Bumped on every change; writers pass the version they read. */
    version: integer("version").notNull().default(1),
    cancelReason: text("cancel_reason"),
    /** The plan the executor was first assigned on; plan-vs-fact compares against it. */
    baselinePlanVersionId: uuid("baseline_plan_version_id"),
    mileageKm: doublePrecision("mileage_km"),
    mileageUnknown: boolean("mileage_unknown").notNull().default(false),
    closeOverrideReason: text("close_override_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [unique("trip_number_key").on(t.orgId, t.number), index("trip_status_idx").on(t.orgId, t.status)],
);

export const tripStops = pgTable(
  "trip_stop",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    seq: integer("seq").notNull(),
    locationId: uuid("location_id").notNull().references(() => locations.id),
    operation: text("operation").$type<"load" | "unload" | "return">().notNull(),
    actualArriveAt: timestamp("actual_arrive_at", { withTimezone: true }),
    actualDepartAt: timestamp("actual_depart_at", { withTimezone: true }),
    /** Set when the stop did not take place; must say why. */
    skippedReason: text("skipped_reason"),
  },
  (t) => [index("trip_stop_trip_idx").on(t.tripId, t.seq)],
);

export const tripCargo = pgTable(
  "trip_cargo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    /** The unloading stop this cargo is destined for. */
    stopId: uuid("stop_id").notNull().references(() => tripStops.id),
    orderLineId: uuid("order_line_id").notNull().references(() => orderLines.id),
    qtyMilli: bigint("qty_milli", { mode: "number" }).notNull(),
    /** Quantity confirmed at loading; null until then. */
    loadedMilli: bigint("loaded_milli", { mode: "number" }),
  },
  (t) => [
    unique("trip_cargo_line_stop").on(t.stopId, t.orderLineId),
    index("trip_cargo_line_idx").on(t.orderLineId),
    index("trip_cargo_trip_idx").on(t.tripId),
  ],
);
