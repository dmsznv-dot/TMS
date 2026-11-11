import { sql } from "drizzle-orm";
import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CostLine } from "@/domain/costEstimate";
import type { WindowState } from "@/domain/eta";
import type { TripStatus } from "@/domain/tripStatus";
import { orderLines } from "./orders";
import { organizations, users } from "./org";
import { counterparties, drivers, locations, vehicles } from "./refs";

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

export type PlanStopSnapshot = {
  stopId: string;
  seq: number;
  operation: "load" | "unload" | "return";
  locationId: string;
  locationName: string;
  address: string | null;
  lat: number;
  lon: number;
  tz: string;
  /** ISO times; null where they do not apply (the loading stop is only departed from). */
  arriveAt: string | null;
  departAt: string;
  waitMin: number;
  windowState: WindowState;
  lateMin: number;
  windowStart: string | null;
  windowEnd: string | null;
  /** Drive time to this stop in seconds. */
  legDurationS: number | null;
};

export const carrierOffers = pgTable(
  "carrier_offer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    carrierId: uuid("carrier_id").notNull().references(() => counterparties.id),
    /** Null while the carrier is only a candidate and has not quoted a rate. */
    rateKop: bigint("rate_kop", { mode: "number" }),
    vatIncluded: boolean("vat_included").notNull().default(true),
    vatRateBp: integer("vat_rate_bp").notNull(),
    vehicleDescr: text("vehicle_descr"),
    confirmedArriveAt: timestamp("confirmed_arrive_at", { withTimezone: true }),
    downtimeTerms: text("downtime_terms"),
    expectedDowntimeKop: bigint("expected_downtime_kop", { mode: "number" }).notNull().default(0),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    source: text("source"),
    status: text("status").$type<"candidate" | "quoted" | "confirmed" | "rejected">().notNull().default("quoted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("carrier_offer_trip_idx").on(t.tripId)],
);

export const planVersions = pgTable(
  "plan_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    versionNo: integer("version_no").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Why the plan was changed; required from the second version. */
    reason: text("reason"),
    executor: text("executor").$type<"own" | "carrier">().notNull(),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    driverId: uuid("driver_id").references(() => drivers.id),
    carrierOfferId: uuid("carrier_offer_id").references(() => carrierOffers.id),
    /** When the truck leaves the loading point (for a carrier: derived from its confirmed arrival). */
    departureAt: timestamp("departure_at", { withTimezone: true }).notNull(),
    distanceM: integer("distance_m").notNull(),
    durationS: integer("duration_s").notNull(),
    metricsSource: text("metrics_source").$type<"2gis" | "synthetic" | "manual">().notNull(),
    tollFiltered: boolean("toll_filtered").notNull().default(false),
    profileComplete: boolean("profile_complete").notNull().default(true),
    legsEstimated: boolean("legs_estimated").notNull().default(false),
    /** Stops with the times and point data as they were when the plan was saved. */
    stopsSnapshot: jsonb("stops_snapshot").$type<PlanStopSnapshot[]>().notNull(),
    costLines: jsonb("cost_lines").$type<CostLine[]>().notNull(),
    assumptions: jsonb("assumptions").$type<string[]>().notNull(),
    totalKop: bigint("total_kop", { mode: "number" }).notNull(),
    incomplete: boolean("incomplete").notNull().default(false),
  },
  (t) => [
    unique("plan_version_no").on(t.tripId, t.versionNo),
    uniqueIndex("plan_version_current").on(t.tripId).where(sql`${t.isCurrent}`),
  ],
);
