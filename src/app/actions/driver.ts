"use server";

import { revalidatePath } from "next/cache";
import { isDomainError } from "@/domain/errors";
import { rateLimit } from "@/server/auth/rateLimit";
import { getDb } from "@/server/db/client";
import { recordEvent } from "@/server/services/execution";
import { ctxFromShareToken } from "@/server/services/shareLinks";

export type DriverActionResult = { ok: true } | { ok: false; message: string };

/** A report from the driver's page. The token is the only credential. */
export async function driverEventAction(
  token: string,
  type: "driver_confirmed" | "arrived" | "loaded" | "unloaded",
  stopId?: string,
): Promise<DriverActionResult> {
  const ctx = await ctxFromShareToken(getDb(), token);
  if (!ctx || ctx.actor.kind !== "driver_link") return { ok: false, message: "Ссылка недействительна" };
  if (!rateLimit(`link:${ctx.actor.linkId}`, 60)) return { ok: false, message: "Слишком много запросов. Подождите минуту." };
  try {
    await recordEvent(ctx, { tripId: ctx.actor.tripId, type, stopId });
    revalidatePath(`/d/${token}`);
    return { ok: true };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, message: e.message };
    console.error("Driver action failed", e instanceof Error ? e.message : e);
    return { ok: false, message: "Не удалось передать отметку. Повторите." };
  }
}
