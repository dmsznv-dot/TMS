import type { LatLon } from "@/domain/geo";
import type { TruckProfile } from "@/domain/truck";

export type { TruckProfile };

export const MIN_POINTS = 2;
/** Most points 2GIS accepts for one set, start and end included. */
export const MAX_POINTS = 10;

export type RoadFilter = "toll_road" | "dirt_road" | "ferry";

export type RouteRequest = {
  /** Start, intermediate stops and end, in driving order. */
  points: LatLon[];
  departureAt: Date;
  truck: TruckProfile | null;
  avoid: RoadFilter[];
  /** Variants wanted in addition to the main one. */
  alternatives: number;
};

export type RouteVariant = {
  id: string;
  source: "2gis" | "synthetic";
  distanceM: number;
  durationS: number;
  /** Drive time to each point after the first; adds up to durationS. */
  legDurationsS: number[];
  /** True when leg times were spread over the total, not reported by the provider. */
  legsEstimated: boolean;
  /** Polylines of [lat, lon] for drawing. Never stored. */
  geometry: [number, number][][];
};

export type RouteFailure =
  | "no_key"
  | "quota"
  | "key_rejected"
  | "timeout"
  | "unavailable"
  | "not_found"
  | "points_too_far"
  | "point_off_road"
  | "bad_request";

export type RouteResult =
  | { ok: true; variants: RouteVariant[]; profileComplete: boolean }
  | { ok: false; reason: RouteFailure; message: string };

export interface RoutingProvider {
  buildRoutes(request: RouteRequest): Promise<RouteResult>;
}

export const FAILURE_MESSAGES: Record<RouteFailure, string> = {
  no_key: "Ключ 2ГИС не задан. Включён режим демо-расчёта или введите оценку вручную.",
  quota: "Лимит запросов 2ГИС исчерпан",
  key_rejected: "2ГИС отклонил ключ: он неверный или истёк",
  timeout: "2ГИС не ответил за 10 секунд. Повторите запрос или введите оценку вручную.",
  unavailable: "2ГИС не ответил. Повторите запрос позже или введите оценку вручную.",
  not_found: "Маршрут между точками не строится",
  points_too_far: "Точки слишком далеко друг от друга для этого ключа",
  point_off_road: "Одна из точек дальше 10 км от дороги",
  bad_request: "Запрос к 2ГИС отклонён: проверьте точки маршрута",
};

export function failure(reason: RouteFailure, message = FAILURE_MESSAGES[reason]): RouteResult {
  return { ok: false, reason, message };
}

/** Checks what every provider requires of the points; null when they are fine. */
export function validatePoints(points: LatLon[]): RouteResult | null {
  if (points.length < MIN_POINTS) return failure("bad_request", "Для маршрута нужно минимум две точки");
  if (points.length > MAX_POINTS) return failure("bad_request", `В одном расчёте не больше ${MAX_POINTS} точек`);
  const valid = points.every(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180,
  );
  return valid ? null : failure("bad_request", "У одной из точек неверные координаты");
}
