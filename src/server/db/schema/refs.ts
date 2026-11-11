import { boolean, doublePrecision, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./org";

const base = {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

export const counterparties = pgTable("counterparty", {
  ...base,
  name: text("name").notNull(),
  kind: text("kind").$type<"customer" | "carrier">().notNull(),
  inn: text("inn"),
  contacts: text("contacts"),
  bodyTypes: text("body_types"),
  directions: text("directions"),
  /** Whether this carrier quotes rates with VAT. */
  vatIncluded: boolean("vat_included").notNull().default(true),
});

export const locations = pgTable(
  "location",
  {
    ...base,
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    tz: text("tz").notNull(),
    kind: text("kind").$type<"warehouse" | "dc" | "customer">().notNull(),
    /** Gate used by trucks when it differs from the address point. */
    entryLat: doublePrecision("entry_lat"),
    entryLon: doublePrecision("entry_lon"),
    entryNotes: text("entry_notes"),
    passRules: text("pass_rules"),
    contact: text("contact"),
    /** Minutes spent loading or unloading at this point. */
    serviceMin: integer("service_min").notNull().default(30),
    /** Wall-clock "HH:mm" in the zone of the point. */
    defaultWindowStart: text("default_window_start"),
    defaultWindowEnd: text("default_window_end"),
    /** Identifier of the point in import files. */
    externalKey: text("external_key"),
  },
  (t) => [unique("location_external_key").on(t.orgId, t.externalKey)],
);

export const vehicles = pgTable("vehicle", {
  ...base,
  plate: text("plate").notNull(),
  bodyType: text("body_type"),
  capacityKg: integer("capacity_kg"),
  capacityPallets: integer("capacity_pallets"),
  capacityM3: doublePrecision("capacity_m3"),
  maxPermMassT: doublePrecision("max_perm_mass_t"),
  massT: doublePrecision("mass_t"),
  axleLoadT: doublePrecision("axle_load_t"),
  heightM: doublePrecision("height_m"),
  widthM: doublePrecision("width_m"),
  lengthM: doublePrecision("length_m"),
  passIds: integer("pass_ids").array().notNull().default([]),
  fuelNormLPer100Km: doublePrecision("fuel_norm_l_100km"),
});

export const drivers = pgTable("driver", {
  ...base,
  name: text("name").notNull(),
  phone: text("phone"),
});
