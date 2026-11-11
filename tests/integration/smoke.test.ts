import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { withTestDb } from "../helpers/testDb";

it("connects to an isolated schema", async () => {
  const t = await withTestDb();
  const r = await t.db.execute(sql`select current_schema() as s`);
  expect(String(r.rows[0].s)).toMatch(/^t_/);
  await t.close();
});
