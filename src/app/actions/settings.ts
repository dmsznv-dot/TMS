"use server";

import type { Role } from "@/domain/permissions";
import { createUser, setUserActive, updateOrgSettings } from "@/server/services/users";
import { run, type ActionResult } from "./run";

export async function updateSettingsAction(patch: {
  name: string;
  vatRateBp: number;
  deliveryAllocBase: "pallets" | "weight";
  fleetRule: "days" | "km";
  fleetRateKop: number;
  fuelPriceKopPerL: number;
  driverHourKop: number;
  windowBufferMin: number;
}): Promise<ActionResult> {
  return run((ctx) => updateOrgSettings(ctx, patch), ["/settings"]);
}

export async function createUserAction(input: { email: string; name: string; role: Role; password: string }): Promise<ActionResult<{ userId: string }>> {
  return run((ctx) => createUser(ctx, input), ["/settings"]);
}

export async function setUserActiveAction(userId: string, active: boolean): Promise<ActionResult> {
  return run((ctx) => setUserActive(ctx, { userId, active }), ["/settings"]);
}
