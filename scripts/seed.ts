// Creates the demo organization in the database named by DATABASE_URL. Run with: npm run seed
import { createDb } from "../src/server/db/client";
import { env } from "../src/server/env";
import { seedDemo } from "../src/server/seed/demo";

async function main() {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const { db, pool } = createDb(env.DATABASE_URL, { max: 1 });
  const { orgId } = await seedDemo(db);
  await pool.end();
  console.log(`Demo organization ready (${orgId}).`);
  console.log("Sign in as admin@demo.local, logist@demo.local, warehouse@demo.local, finance@demo.local or manager@demo.local");
  console.log(`Password: ${env.SEED_PASSWORD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
