import { z } from "zod";
import { checkCompleteness, COMPLETENESS_LABELS, type CompletenessCode } from "@/domain/completeness";
import { DomainError } from "@/domain/errors";
import { requireCan, type Ctx } from "../auth/context";
import { audit, inTransaction } from "./audit";
import { gatherCompleteness } from "./completenessData";
import { lockTrip, moveTrip } from "./trips";
import { parseInput } from "./validation";

/** Whether the data of the trip is whole enough to close it, and what is missing. */
export async function getCompleteness(ctx: Ctx, tripId: string): Promise<{ ok: boolean; failed: CompletenessCode[] }> {
  requireCan(ctx, "money.read");
  return checkCompleteness(await gatherCompleteness(ctx, tripId));
}

const closeInput = z.object({ tripId: z.uuid(), expectedVersion: z.number().int(), overrideReason: z.string().optional() });

/**
 * Closes a completed trip financially. Incomplete data blocks it unless the
 * person closing gives a reason; the reason and what was missing are recorded.
 */
export async function closeTrip(ctx: Ctx, input: z.input<typeof closeInput>): Promise<{ version: number }> {
  requireCan(ctx, "trip.close");
  const data = parseInput(closeInput, input);
  const reason = data.overrideReason?.trim() || undefined;

  return inTransaction(ctx, async (tx) => {
    const trip = await lockTrip(tx, data.tripId, data.expectedVersion, null);
    if (trip.status !== "completed") {
      throw new DomainError("invalid_transition", "Финансово закрыть можно только выполненный рейс");
    }

    const completeness = checkCompleteness(await gatherCompleteness(tx, data.tripId));
    if (!completeness.ok && !reason) {
      throw new DomainError(
        "incomplete",
        `Данные рейса неполны: ${completeness.failed.map((c) => COMPLETENESS_LABELS[c]).join("; ")}. Укажите причину, чтобы закрыть рейс так.`,
        { failed: completeness.failed },
      );
    }

    const moved = await moveTrip(tx, data.tripId, "closed", { expectedVersion: data.expectedVersion, overrideReason: reason });
    if (!completeness.ok) {
      await audit(tx, { entity: "trip", entityId: data.tripId, action: "close_override", after: { reason, failed: completeness.failed } });
    }
    return moved;
  });
}
