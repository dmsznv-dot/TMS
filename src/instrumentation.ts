/** Runs once when the server starts. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;

  if (process.env.RUN_MIGRATIONS === "true") {
    const { runMigrations } = await import("./server/db/migrate");
    await runMigrations(process.env.DATABASE_URL);
  }
  if (process.env.SEED_DEMO === "true") {
    const { getDb } = await import("./server/db/client");
    const { seedDemo } = await import("./server/seed/demo");
    await seedDemo(getDb());
  }

  const { startImportWorker } = await import("./server/import/worker");
  startImportWorker();
}
