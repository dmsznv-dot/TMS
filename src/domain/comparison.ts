import type { CostEstimate } from "./costEstimate";
import type { StopPlan } from "./eta";

export type Option = {
  id: string;
  label: string;
  executor: "own" | "carrier";
  stops: StopPlan[];
  cost: CostEstimate;
};

export type ComparisonRow = Option & {
  /** False when some stop is reached after its window closes. */
  fits: boolean;
  reason: string | null;
};

/**
 * Orders the options for the planner: those that make every window first,
 * each group by rising cost. An option that misses a window says by how much.
 */
export function buildComparison(options: Option[], formatTime: (d: Date) => string): ComparisonRow[] {
  const rows = options.map((option): ComparisonRow => {
    const worst = option.stops.reduce<StopPlan | null>(
      (acc, s) => (s.windowState === "late" && (!acc || s.lateMin > acc.lateMin) ? s : acc),
      null,
    );
    if (!worst) return { ...option, fits: true, reason: null };
    const until = worst.windowEnd ? ` к окну до ${formatTime(worst.windowEnd)}` : "";
    return { ...option, fits: false, reason: `Опоздание ${worst.lateMin} мин${until}` };
  });

  return rows.sort(
    (a, b) =>
      Number(b.fits) - Number(a.fits) ||
      a.cost.totalKop - b.cost.totalKop ||
      a.label.localeCompare(b.label, "ru"),
  );
}
