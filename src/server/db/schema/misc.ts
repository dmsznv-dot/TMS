import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./org";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
