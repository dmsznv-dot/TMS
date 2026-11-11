import { apportion, haversineM } from "@/domain/geo";
import { isTruckProfileComplete } from "@/domain/truck";
import { parseLineStringWkt } from "./wkt";
import {
  failure,
  validatePoints,
  type RouteFailure,
  type RouteRequest,
  type RouteResult,
  type RouteVariant,
  type RoutingProvider,
} from "./types";

const ENDPOINT = "https://routing.api.2gis.com/routing/7.0.0/global";
const DEFAULT_TIMEOUT_MS = 10_000;
/** A departure this far ahead of now is treated as a planned time, not "right away". */
const FUTURE_THRESHOLD_MS = 5 * 60_000;

/** The JSON body of a truck route request. Profile fields that are unknown are left out. */
export function buildTwoGisBody(req: RouteRequest, now: Date): Record<string, unknown> {
  const body: Record<string, unknown> = {
    points: req.points.map((p) => ({ type: "stop", lon: p.lon, lat: p.lat })),
    transport: "truck",
    output: "detailed",
    locale: "ru",
    alternative: req.alternatives,
  };

  if (req.avoid.length > 0) body.filters = req.avoid;

  if (req.truck) {
    const t = req.truck;
    const truck: Record<string, unknown> = {};
    if (t.maxPermMassT != null) truck.max_perm_mass = t.maxPermMassT;
    if (t.massT != null) truck.mass = t.massT;
    if (t.axleLoadT != null) truck.axle_load = t.axleLoadT;
    if (t.heightM != null) truck.height = t.heightM;
    if (t.widthM != null) truck.width = t.widthM;
    if (t.lengthM != null) truck.length = t.lengthM;
    if (t.passIds && t.passIds.length > 0) truck.pass_zone_pass_ids = t.passIds;
    if (Object.keys(truck).length > 0) body.params = { truck };
  }

  if (req.departureAt.getTime() - now.getTime() > FUTURE_THRESHOLD_MS) {
    body.traffic_mode = "statistics";
    body.utc = Math.floor(req.departureAt.getTime() / 1000);
  } else {
    body.traffic_mode = "jam";
  }
  return body;
}

const STATUS_FAILURES: Record<string, RouteFailure> = {
  ROUTE_NOT_FOUND: "not_found",
  ROUTE_DOES_NOT_EXISTS: "not_found",
  ATTRACT_FAIL: "point_off_road",
  POINT_EXCLUDED: "bad_request",
  FAIL: "unavailable",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function geometryOf(item: Record<string, unknown>): [number, number][][] {
  const lines: [number, number][][] = [];
  const maneuvers = Array.isArray(item.maneuvers) ? item.maneuvers : [];
  for (const m of maneuvers) {
    const path = isObject(m) && isObject(m.outcoming_path) ? m.outcoming_path : null;
    const pieces = path && Array.isArray(path.geometry) ? path.geometry : [];
    for (const piece of pieces) {
      const selection = isObject(piece) ? piece.selection : null;
      if (typeof selection !== "string") continue;
      const line = parseLineStringWkt(selection);
      if (line.length > 1) lines.push(line);
    }
  }
  return lines;
}

/**
 * Turns an HTTP status and parsed body into a route result. The documented
 * answer does not give drive time per intermediate point, so the total is
 * spread over the legs in proportion to their straight-line length and the
 * variant is marked as estimated.
 */
export function parseTwoGisResponse(
  httpStatus: number,
  body: unknown,
  straightLegsM: number[],
  profileComplete: boolean,
): RouteResult {
  if (httpStatus === 401 || httpStatus === 403) return failure("key_rejected");
  if (httpStatus === 429) return failure("quota");
  if (httpStatus === 400 || httpStatus === 422) return failure("bad_request");
  if (httpStatus < 200 || httpStatus >= 300) return failure("unavailable");

  if (!isObject(body) || typeof body.status !== "string") return failure("unavailable");
  if (body.status !== "OK") return failure(STATUS_FAILURES[body.status] ?? "unavailable");

  const items = Array.isArray(body.result) ? body.result : [];
  const variants: RouteVariant[] = [];
  items.forEach((item, index) => {
    if (!isObject(item) || !isCount(item.total_distance) || !isCount(item.total_duration)) return;
    const durationS = Math.round(item.total_duration);
    variants.push({
      id: String(item.id ?? index + 1),
      source: "2gis",
      distanceM: Math.round(item.total_distance),
      durationS,
      legDurationsS: apportion(durationS, straightLegsM),
      legsEstimated: true,
      geometry: geometryOf(item),
    });
  });
  return variants.length > 0 ? { ok: true, variants, profileComplete } : failure("unavailable");
}

type ProviderOptions = { apiKey: string; fetchFn?: typeof fetch; timeoutMs?: number };

/** Routing through 2GIS Routing API. One attempt per call: the user decides about a retry. */
export function createTwoGisProvider({ apiKey, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: ProviderOptions): RoutingProvider {
  return {
    async buildRoutes(req: RouteRequest): Promise<RouteResult> {
      const invalid = validatePoints(req.points);
      if (invalid) return invalid;

      const straightLegsM = req.points.slice(1).map((p, i) => haversineM(req.points[i], p));
      const body = buildTwoGisBody(req, new Date());

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        if (controller.signal.aborted) return failure("timeout");
        return parseTwoGisResponse(response.status, parsed, straightLegsM, isTruckProfileComplete(req.truck));
      } catch {
        // The error text is dropped on purpose: a network error can quote the URL, and the URL holds the key.
        return failure(controller.signal.aborted ? "timeout" : "unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
