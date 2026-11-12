import { apportion, haversineM } from "@/domain/geo";
import { isTruckProfileComplete } from "@/domain/truck";
import { validatePoints, type RouteRequest, type RouteResult, type RouteVariant, type RoutingProvider } from "./types";

type Options = { speedKmh?: number; detour?: number };

/**
 * A built-in estimate for demos and tests: straight-line distance times a
 * detour factor at an average speed. It makes no external requests and its
 * variants are always labelled "synthetic".
 */
export function createSyntheticProvider({ speedKmh = 30, detour = 1.3 }: Options = {}): RoutingProvider {
  const metresPerSecond = speedKmh / 3.6;

  function variant(req: RouteRequest, id: string, distanceFactor: number, speedFactor: number, bend: number): RouteVariant {
    const legsM = req.points.slice(1).map((p, i) => Math.round(haversineM(req.points[i], p) * detour * distanceFactor));
    const distanceM = legsM.reduce((a, b) => a + b, 0);
    const durationS = Math.round(distanceM / (metresPerSecond * speedFactor));
    const geometry = req.points.slice(1).map((end, i): [number, number][] => {
      const start = req.points[i];
      const middle: [number, number] = [(start.lat + end.lat) / 2 + bend, (start.lon + end.lon) / 2 + bend];
      return bend === 0 ? [[start.lat, start.lon], [end.lat, end.lon]] : [[start.lat, start.lon], middle, [end.lat, end.lon]];
    });
    return {
      id,
      source: "synthetic",
      distanceM,
      durationS,
      legDurationsS: apportion(durationS, legsM),
      legsEstimated: false,
      geometry,
    };
  }

  return {
    async buildRoutes(req: RouteRequest): Promise<RouteResult> {
      const invalid = validatePoints(req.points);
      if (invalid) return invalid;
      const variants = [variant(req, "1", 1, 1, 0)];
      if (req.alternatives > 0) // The alternative is longer but faster, like a bypass.
      variants.push(variant(req, "2", 1.15, 1.35, 0.004));
      return { ok: true, variants, profileComplete: isTruckProfileComplete(req.truck) };
    },
  };
}

