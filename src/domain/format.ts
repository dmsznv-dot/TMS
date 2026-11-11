import type { WindowState } from "./eta";

/** "5,9 км" or "450 м". */
export function formatKm(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} м`;
  return `${(metres / 1000).toFixed(1).replace(".", ",")} км`;
}

/** "1 ч 05 мин" or "18 мин"; seconds are rounded up to a whole minute. */
export function formatDuration(seconds: number): string {
  const totalMin = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return hours > 0 ? `${hours} ч ${String(minutes).padStart(2, "0")} мин` : `${minutes} мин`;
}

export const WINDOW_STATE_LABELS: Record<WindowState, string> = {
  on_time: "в окне",
  risk: "риск",
  late: "опоздание",
  no_window: "без окна",
};

export function formatWindowState(state: WindowState): string {
  return WINDOW_STATE_LABELS[state];
}
