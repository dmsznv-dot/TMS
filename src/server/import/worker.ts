import { getDb } from "../db/client";
import { processNextJob } from "./jobs";

const POLL_MS = 2000;
const state = globalThis as unknown as { __tmsImportWorker?: boolean };

/** Starts the in-process loop that applies queued import jobs. */
export function startImportWorker(): void {
  if (state.__tmsImportWorker) return;
  state.__tmsImportWorker = true;

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      while (await processNextJob(getDb())) {
        // keep going until the queue is empty
      }
    } catch (e) {
      console.error("Import worker error:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }, POLL_MS).unref();
}
