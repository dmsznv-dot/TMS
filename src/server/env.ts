import { z } from "zod";

const boolFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(16).optional(),
  ROUTING_MODE: z.enum(["synthetic", "live"]).default("synthetic"),
  TWOGIS_API_KEY: z.string().min(1).optional(),
  TWOGIS_KEY_EXPIRES_AT: z.string().optional(),
  TWOGIS_REQUEST_LIMIT: z.coerce.number().int().positive().default(1000),
  ROUTE_METRICS_STORAGE: z.enum(["plan", "none"]).default("plan"),
  EXPORT_PROVIDER_METRICS: boolFromString,
  MAP_TILE_URL: z
    .string()
    .default("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
  /** "true" or "false"; defaults to true in production. Set false only for plain-HTTP installs. */
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  SEED_PASSWORD: z.string().min(8).default("demo12345"),
});

export type Env = Omit<z.infer<typeof envSchema>, "SESSION_SECRET" | "SESSION_COOKIE_SECURE"> & {
  SESSION_SECRET: string;
  SESSION_COOKIE_SECURE: boolean;
};

const DEV_SECRET = "dev-only-session-secret-not-for-production";

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // docker compose passes `VAR: ${VAR:-}` as an empty string; that means "not set".
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const parsed = envSchema.parse(present);
  if (!parsed.SESSION_SECRET && parsed.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production");
  }
  return {
    ...parsed,
    SESSION_SECRET: parsed.SESSION_SECRET ?? DEV_SECRET,
    SESSION_COOKIE_SECURE: parsed.SESSION_COOKIE_SECURE
      ? parsed.SESSION_COOKIE_SECURE === "true"
      : parsed.NODE_ENV === "production",
  };
}

let cached: Env | undefined;

/** Drops the cached environment. Tests call it after changing process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** Lazily parsed environment; reading a field parses process.env once. */
export const env: Env = new Proxy({} as Env, {
  get(_target, key) {
    cached ??= loadEnv();
    return cached[key as keyof Env];
  },
});
