import { env } from "../env";
import { createSyntheticProvider } from "./synthetic";
import { createTwoGisProvider } from "./twogis";
import { failure, type RoutingProvider } from "./types";

/** The provider selected by ROUTING_MODE. Live mode without a key answers "no_key". */
export function getRoutingProvider(): RoutingProvider {
  if (env.ROUTING_MODE === "synthetic") return createSyntheticProvider();
  const apiKey = env.TWOGIS_API_KEY;
  if (!apiKey) return { buildRoutes: async () => failure("no_key") };
  return createTwoGisProvider({ apiKey });
}
