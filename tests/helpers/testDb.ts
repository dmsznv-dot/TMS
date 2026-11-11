import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { createDb, type Db } from "@/server/db/client";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../drizzle");

/**
 * Applies the generated migrations inside one schema. drizzle-kit qualifies
 * foreign keys with "public"; the qualifier is removed so every test file
 * gets its own copy of the tables.
 */
async function migrateInto(pool: Pool): Promise<void> {
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  if (!existsSync(journalPath)) return;
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    const sqlText = readFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8",
    ).replaceAll('"public".', "");
    for (const statement of sqlText.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  }
}

export async function withTestDb(): Promise<{
  db: Db;
  close(): Promise<void>;
}> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const schemaName = `t_${randomBytes(6).toString("hex")}`;

  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`create schema "${schemaName}"`);

  const { db, pool } = createDb(url, { searchPath: schemaName, max: 6 });
  try {
    await migrateInto(pool);
  } catch (e) {
    await pool.end();
    await admin.query(`drop schema "${schemaName}" cascade`);
    await admin.end();
    throw e;
  }

  return {
    db,
    async close() {
      await pool.end();
      await admin.query(`drop schema "${schemaName}" cascade`);
      await admin.end();
    },
  };
}
