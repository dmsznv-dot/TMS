import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Role } from "@/domain/permissions";

export const organizations = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Default VAT rate in basis points: 22 % = 2200. */
  vatRateBp: integer("vat_rate_bp").notNull().default(2200),
  /** Base for spreading delivery cost over orders. */
  deliveryAllocBase: text("delivery_alloc_base").$type<"pallets" | "weight">().notNull().default("pallets"),
  /** How fleet overhead is charged to a trip. */
  fleetRule: text("fleet_rule").$type<"days" | "km">().notNull().default("days"),
  fleetRateKop: integer("fleet_rate_kop").notNull().default(0),
  fuelPriceKopPerL: integer("fuel_price_kop_per_l").notNull().default(7000),
  driverHourKop: integer("driver_hour_kop").notNull().default(60000),
  windowBufferMin: integer("window_buffer_min").notNull().default(15),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("app_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").$type<Role>().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("user_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
