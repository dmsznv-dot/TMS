import type { WindowState } from "@/domain/eta";
import { formatWindowState } from "@/domain/format";
import { TRIP_STATUS_LABELS, type TripStatus } from "@/domain/tripStatus";
import { Badge } from "./ui";

const TRIP_TONES: Record<TripStatus, "gray" | "green" | "amber" | "red" | "blue"> = {
  draft: "gray",
  planned: "blue",
  assigned: "blue",
  in_progress: "amber",
  completed: "green",
  closed: "green",
  cancelled: "red",
};

export function TripStatusBadge({ status }: { status: TripStatus }) {
  return <Badge tone={TRIP_TONES[status]}>{TRIP_STATUS_LABELS[status]}</Badge>;
}

const WINDOW_TONES: Record<WindowState, "gray" | "green" | "amber" | "red"> = {
  on_time: "green",
  risk: "amber",
  late: "red",
  no_window: "gray",
};

export function WindowBadge({ state, lateMin }: { state: WindowState; lateMin?: number }) {
  return (
    <Badge tone={WINDOW_TONES[state]}>
      {formatWindowState(state)}
      {state === "late" && lateMin ? ` на ${lateMin} мин` : ""}
    </Badge>
  );
}
