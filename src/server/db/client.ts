import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

/** A database handle or an open transaction: services accept either. */
export type Db = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export function createDb(
  connectionString: string,
  options: { searchPath?: string; max?: number } = {},
): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    options: options.searchPath
      ? `-c search_path=${options.searchPath}`
      : undefined,
  });
  return { db: drizzle(pool, { schema }), pool };
}

const globalForDb = globalThis as unknown as { __tmsDb?: Db };

/** Process-wide database handle built from DATABASE_URL. */
export function getDb(): Db {
  if (!globalForDb.__tmsDb) {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    globalForDb.__tmsDb = createDb(env.DATABASE_URL).db;
  }
  return globalForDb.__tmsDb;
}
