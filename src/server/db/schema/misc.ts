import { bigint, boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./org";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Insertion order: entries of one transaction share the same time, so this keeps them in sequence. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    actorKind: text("actor_kind").$type<"user" | "driver_link" | "system">().notNull(),
    actorId: text("actor_id"),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.orgId, t.entity, t.entityId)],
);

/** Link between an internal record and its identifier in an outside system. */
export const externalRefs = pgTable(
  "external_ref",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    source: text("source").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    externalId: text("external_id").notNull(),
  },
  (t) => [unique("external_ref_key").on(t.orgId, t.source, t.entityType, t.externalId)],
);

/** One request to a routing provider. The answer itself is never stored. */
export const routingRequestLog = pgTable(
  "routing_request_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").references(() => users.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    provider: text("provider").$type<"2gis" | "synthetic">().notNull(),
    ok: boolean("ok").notNull(),
    reason: text("reason"),
  },
  (t) => [index("routing_request_log_provider_idx").on(t.provider, t.ok)],
);
