export type WindowState = "on_time" | "risk" | "late" | "no_window";

export type StopPlan = {
  arriveAt: Date;
  /** Minutes spent waiting for the window to open. */
  waitMin: number;
  departAt: Date;
  windowState: WindowState;
  /** Minutes past the end of the window; 0 unless late. */
  lateMin: number;
  windowEnd: Date | null;
};

export type StopInput = {
  serviceMin: number;
  windowStart: Date | null;
  windowEnd: Date | null;
};

const MIN_MS = 60_000;

/**
 * Arrival and departure at each stop, starting from the moment the truck
 * leaves the loading point. `legDurationsS[i]` is the drive to `stops[i]`.
 * An early arrival waits for the window to open, which delays later stops.
 * "At risk" means arriving within `bufferMin` of the end of the window.
 */
export function computeStopPlans(
  departureAt: Date,
  legDurationsS: number[],
  stops: StopInput[],
  bufferMin: number,
): StopPlan[] {
  if (legDurationsS.length !== stops.length) {
    throw new Error("legDurationsS and stops must have the same length");
  }
  const plans: StopPlan[] = [];
  let clock = departureAt.getTime();

  stops.forEach((stop, i) => {
    const arrive = clock + legDurationsS[i] * 1000;
    const opens = stop.windowStart?.getTime() ?? null;
    const waitMin = opens != null && arrive < opens ? Math.ceil((opens - arrive) / MIN_MS) : 0;
    const serviceStart = arrive + waitMin * MIN_MS;
    const depart = serviceStart + stop.serviceMin * MIN_MS;

    let windowState: WindowState = "no_window";
    let lateMin = 0;
    if (stop.windowEnd) {
      const end = stop.windowEnd.getTime();
      if (arrive <= end - bufferMin * MIN_MS) windowState = "on_time";
      else if (arrive <= end) windowState = "risk";
      else {
        windowState = "late";
        lateMin = Math.ceil((arrive - end) / MIN_MS);
      }
    }

    plans.push({ arriveAt: new Date(arrive), waitMin, departAt: new Date(depart), windowState, lateMin, windowEnd: stop.windowEnd });
    clock = depart;
  });
  return plans;
}
