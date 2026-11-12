"use server";

import {
  recordAcceptance,
  type acceptanceInput,
} from "@/server/services/acceptance";
import { confirmLoading, recordEvent, setMileage, setStopFact } from "@/server/services/execution";
import { createShareLink, revokeShareLink } from "@/server/services/shareLinks";
import { completeTask } from "@/server/services/tasks";
import type { z } from "zod";
import { run, type ActionResult } from "./run";

const tab = (tripId: string) => [`/trips/${tripId}`, "/trips", "/planning"];

export async function createShareLinkAction(tripId: string, ttlDays: number): Promise<ActionResult<{ token: string; expiresAt: Date }>> {
  return run((ctx) => createShareLink(ctx, { tripId, ttlDays }), tab(tripId));
}

export async function revokeShareLinkAction(tripId: string, linkId: string): Promise<ActionResult> {
  return run((ctx) => revokeShareLink(ctx, linkId), tab(tripId));
}

export async function confirmLoadingAction(
  tripId: string,
  items: { tripCargoId: string; loadedMilli: number }[],
): Promise<ActionResult> {
  return run((ctx) => confirmLoading(ctx, { tripId, items }), tab(tripId));
}

export async function setStopFactAction(tripId: string, stopId: string, arriveAt: Date | null, departAt: Date | null): Promise<ActionResult> {
  return run((ctx) => setStopFact(ctx, { stopId, arriveAt: arriveAt ?? undefined, departAt: departAt ?? undefined }), tab(tripId));
}

export async function skipStopAction(tripId: string, stopId: string, reason: string): Promise<ActionResult<{ recorded: boolean }>> {
  return run((ctx) => recordEvent(ctx, { tripId, type: "stop_skipped", stopId, skippedReason: reason }), tab(tripId));
}

export async function setMileageAction(tripId: string, km: number | null, unknown: boolean): Promise<ActionResult> {
  return run((ctx) => setMileage(ctx, { tripId, km, unknown }), tab(tripId));
}

export async function recordAcceptanceAction(
  tripId: string,
  input: z.input<typeof acceptanceInput>,
): Promise<ActionResult<{ versionNo: number; taskId: string | null }>> {
  return run((ctx) => recordAcceptance(ctx, input), tab(tripId));
}

export async function completeTaskAction(tripId: string, taskId: string, resolution: string): Promise<ActionResult> {
  return run((ctx) => completeTask(ctx, { taskId, resolution }), tab(tripId));
}
