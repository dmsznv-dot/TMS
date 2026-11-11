import type { ImportJobStatus } from "@/server/db/schema";

export const JOB_STATUS_LABELS: Record<ImportJobStatus, string> = {
  uploaded: "Загружен",
  validated: "Проверен",
  queued: "В очереди",
  processing: "Обрабатывается",
  done: "Готово",
  failed: "Сбой",
};

export const JOB_STATUS_TONES: Record<ImportJobStatus, "gray" | "green" | "amber" | "red" | "blue"> = {
  uploaded: "gray",
  validated: "blue",
  queued: "amber",
  processing: "amber",
  done: "green",
  failed: "red",
};
