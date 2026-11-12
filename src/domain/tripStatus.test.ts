import { describe, expect, it } from "vitest";
import { checkTransition, type TripFacts, type TripStatus } from "./tripStatus";

const facts = (patch: Partial<TripFacts> = {}): TripFacts => ({
  hasCargoStops: true,
  hasCurrentPlan: true,
  executorReady: true,
  hasExecutionEvent: true,
  allStopsResolved: true,
  completenessOk: true,
  overrideReason: null,
  cancelReason: null,
  ...patch,
});

type Case = [from: TripStatus, to: TripStatus, allowed: Partial<TripFacts>, blocked: Partial<TripFacts>, blockedCode: string];

const FORWARD: Case[] = [
  ["draft", "planned", {}, { hasCurrentPlan: false }, "no_plan"],
  ["draft", "planned", {}, { hasCargoStops: false }, "no_cargo"],
  ["planned", "assigned", {}, { executorReady: false }, "executor_not_ready"],
  ["assigned", "in_progress", {}, { hasExecutionEvent: false }, "no_execution_event"],
  ["in_progress", "completed", {}, { allStopsResolved: false }, "stops_unresolved"],
  ["completed", "closed", {}, { completenessOk: false }, "incomplete"],
];

describe("checkTransition: forward steps", () => {
  it.each(FORWARD)("%s → %s needs its precondition", (from, to, allowed, blocked, code) => {
    expect(checkTransition(from, to, facts(allowed))).toEqual({ ok: true });
    expect(checkTransition(from, to, facts(blocked))).toEqual({ ok: false, code });
  });

  it("closing an incomplete trip is allowed with a recorded reason", () => {
    expect(checkTransition("completed", "closed", facts({ completenessOk: false, overrideReason: "Топливо подтвердим позже" }))).toEqual({ ok: true });
  });

  it("a blank override reason does not count", () => {
    expect(checkTransition("completed", "closed", facts({ completenessOk: false, overrideReason: "   " }))).toEqual({ ok: false, code: "incomplete" });
  });

  it("an executor change after assignment returns the trip to planned", () => {
    expect(checkTransition("assigned", "planned", facts())).toEqual({ ok: true });
  });
});

describe("checkTransition: cancellation", () => {
  it.each(["draft", "planned", "assigned", "in_progress"] as const)("%s can be cancelled with a reason", (from) => {
    expect(checkTransition(from, "cancelled", facts({ cancelReason: "Клиент отказался" }))).toEqual({ ok: true });
  });

  it("cancelling needs a reason", () => {
    expect(checkTransition("draft", "cancelled", facts({ cancelReason: null }))).toEqual({ ok: false, code: "cancel_reason_required" });
    expect(checkTransition("planned", "cancelled", facts({ cancelReason: "  " }))).toEqual({ ok: false, code: "cancel_reason_required" });
  });

  it.each(["completed", "closed"] as const)("%s cannot be cancelled", (from) => {
    expect(checkTransition(from, "cancelled", facts({ cancelReason: "поздно" }))).toEqual({ ok: false, code: "invalid_transition" });
  });
});

describe("checkTransition: everything else is rejected", () => {
  it("skipping a step", () => {
    expect(checkTransition("draft", "assigned", facts())).toEqual({ ok: false, code: "invalid_transition" });
    expect(checkTransition("planned", "completed", facts())).toEqual({ ok: false, code: "invalid_transition" });
  });
  it("moving backwards after work has started", () => {
    expect(checkTransition("in_progress", "assigned", facts())).toEqual({ ok: false, code: "invalid_transition" });
    expect(checkTransition("closed", "completed", facts())).toEqual({ ok: false, code: "invalid_transition" });
  });
  it("leaving a cancelled trip", () => {
    expect(checkTransition("cancelled", "draft", facts())).toEqual({ ok: false, code: "invalid_transition" });
  });
  it("staying in the same status", () => {
    expect(checkTransition("planned", "planned", facts())).toEqual({ ok: false, code: "invalid_transition" });
  });
});
