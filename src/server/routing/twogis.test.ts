import { describe, expect, it, vi } from "vitest";
import { NOT_FOUND, twoVariantsResponse } from "./fixtures/twogis";
import type { RouteRequest } from "./types";
import { buildTwoGisBody, createTwoGisProvider, parseTwoGisResponse } from "./twogis";

const A = { lat: 55.0302, lon: 82.9204 };
const B = { lat: 55.06, lon: 82.95 };
const NOW = new Date("2026-11-12T03:00:00Z");

const request = (patch: Partial<RouteRequest> = {}): RouteRequest => ({
  points: [A, B],
  departureAt: NOW,
  truck: null,
  avoid: [],
  alternatives: 1,
  ...patch,
});

describe("buildTwoGisBody", () => {
  it("asks for a detailed truck route through typed stops", () => {
    expect(buildTwoGisBody(request(), NOW)).toMatchObject({
      points: [
        { type: "stop", lon: A.lon, lat: A.lat },
        { type: "stop", lon: B.lon, lat: B.lat },
      ],
      transport: "truck",
      output: "detailed",
      locale: "ru",
      alternative: 1,
    });
  });

  it("sends only the profile fields that are known", () => {
    const body = buildTwoGisBody(request({ truck: { maxPermMassT: 12, widthM: 2.5, lengthM: 8, passIds: [3, 4] } }), NOW);
    expect(body.params).toEqual({ truck: { max_perm_mass: 12, width: 2.5, length: 8, pass_zone_pass_ids: [3, 4] } });
  });

  it("maps every profile field to its 2GIS name", () => {
    const body = buildTwoGisBody(
      request({ truck: { maxPermMassT: 5, massT: 4, axleLoadT: 1.5, heightM: 2.57, widthM: 2.5, lengthM: 5.44, passIds: [2] } }),
      NOW,
    );
    expect(body.params).toEqual({
      truck: { max_perm_mass: 5, mass: 4, axle_load: 1.5, height: 2.57, width: 2.5, length: 5.44, pass_zone_pass_ids: [2] },
    });
  });

  it("omits params without a profile", () => {
    expect(buildTwoGisBody(request(), NOW)).not.toHaveProperty("params");
  });

  it("uses current traffic for an immediate departure", () => {
    expect(buildTwoGisBody(request({ departureAt: new Date(NOW.getTime() + 2 * 60_000) }), NOW)).toMatchObject({ traffic_mode: "jam" });
    expect(buildTwoGisBody(request({ departureAt: new Date(NOW.getTime() - 3600_000) }), NOW)).not.toHaveProperty("utc");
  });

  it("uses statistics traffic and a Unix time for a later departure", () => {
    const body = buildTwoGisBody(request({ departureAt: new Date("2026-11-12T09:00:00Z") }), NOW);
    expect(body).toMatchObject({ traffic_mode: "statistics", utc: Date.parse("2026-11-12T09:00:00Z") / 1000 });
  });

  it("adds road filters only when asked", () => {
    expect(buildTwoGisBody(request(), NOW)).not.toHaveProperty("filters");
    expect(buildTwoGisBody(request({ avoid: ["toll_road"] }), NOW)).toMatchObject({ filters: ["toll_road"] });
  });
});

describe("parseTwoGisResponse", () => {
  it("returns every variant with distance, duration and geometry as [lat, lon]", () => {
    const result = parseTwoGisResponse(200, twoVariantsResponse(), [5000], true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.profileComplete).toBe(true);
    expect(result.variants).toHaveLength(2);
    const [first, second] = result.variants;
    expect(first).toMatchObject({ id: "6157325219231242068", source: "2gis", distanceM: 5904, durationS: 1099 });
    expect(first.geometry[0][0]).toEqual([55.0303, 82.9206]);
    expect(first.geometry).toHaveLength(2);
    expect(second).toMatchObject({ distanceM: 6400, durationS: 1180 });
  });

  it("spreads the total time over the legs when the response has no per-leg times", () => {
    const result = parseTwoGisResponse(200, twoVariantsResponse(), [1000, 3000], false);
    if (!result.ok) throw new Error(result.reason);
    const first = result.variants[0];
    expect(first.legsEstimated).toBe(true);
    expect(first.legDurationsS).toHaveLength(2);
    expect(first.legDurationsS.reduce((a, b) => a + b, 0)).toBe(1099);
    expect(first.legDurationsS[1]).toBeGreaterThan(first.legDurationsS[0]);
    expect(result.profileComplete).toBe(false);
  });

  it.each([
    ["ROUTE_NOT_FOUND", "not_found"],
    ["ROUTE_DOES_NOT_EXISTS", "not_found"],
    ["ATTRACT_FAIL", "point_off_road"],
    ["POINT_EXCLUDED", "bad_request"],
    ["FAIL", "unavailable"],
  ])("maps status %s to %s", (status, reason) => {
    expect(parseTwoGisResponse(200, { ...NOT_FOUND, status }, [1000], true)).toMatchObject({ ok: false, reason });
  });

  it.each([
    [401, "key_rejected"],
    [403, "key_rejected"],
    [429, "quota"],
    [400, "bad_request"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("maps HTTP %i to %s", (code, reason) => {
    expect(parseTwoGisResponse(code, { meta: { code } }, [1000], true)).toMatchObject({ ok: false, reason });
  });

  it.each([
    ["html", "<html>Bad gateway</html>"],
    ["null", null],
    ["a string", "ok"],
    ["an array", []],
    ["json without status", { result: [] }],
    ["an unknown status", { status: "SOMETHING_NEW", result: [] }],
    ["OK without variants", { status: "OK", result: [] }],
    ["OK with variants lacking totals", { status: "OK", result: [{ id: "1" }] }],
    ["OK with non-numeric totals", { status: "OK", result: [{ id: "1", total_distance: "5", total_duration: "9" }] }],
  ])("treats %s as unavailable", (_name, body) => {
    expect(parseTwoGisResponse(200, body, [1000], true)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("keeps good variants when another one is malformed", () => {
    const body = twoVariantsResponse();
    (body.result[1] as { total_duration: unknown }).total_duration = null;
    const result = parseTwoGisResponse(200, body, [1000], true);
    expect(result.ok && result.variants.map((v) => v.distanceM)).toEqual([5904]);
  });
});

describe("createTwoGisProvider", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("posts the request to the routing endpoint with the key in the query", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(twoVariantsResponse()));
    const provider = createTwoGisProvider({ apiKey: "KEY 1", fetchFn });
    const result = await provider.buildRoutes(request({ truck: { maxPermMassT: 12, heightM: 3, widthM: 2.5, lengthM: 8 } }));

    expect(result.ok && result.profileComplete).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://routing.api.2gis.com/routing/7.0.0/global?key=KEY%201");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toMatchObject({ transport: "truck", points: [{ type: "stop" }, { type: "stop" }] });
  });

  it("does not call the network for an invalid request", async () => {
    const fetchFn = vi.fn();
    const result = await createTwoGisProvider({ apiKey: "k", fetchFn }).buildRoutes(request({ points: [A] }));
    expect(result).toMatchObject({ ok: false, reason: "bad_request" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns timeout when the answer takes longer than allowed", async () => {
    const fetchFn = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const result = await createTwoGisProvider({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 }).buildRoutes(request());
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("returns timeout when the body stalls after the headers", async () => {
    const fetchFn = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        Promise.resolve({
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            }),
        } as unknown as Response),
    );
    const result = await createTwoGisProvider({ apiKey: "k", fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 20 }).buildRoutes(request());
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("returns unavailable when the network fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await createTwoGisProvider({ apiKey: "k", fetchFn }).buildRoutes(request())).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable for an HTML page, an empty body and an unexpected JSON", async () => {
    for (const response of [
      new Response("<html>oops</html>", { status: 200 }),
      new Response("", { status: 200 }),
      jsonResponse({ hello: "world" }),
    ]) {
      const fetchFn = vi.fn().mockResolvedValue(response);
      expect(await createTwoGisProvider({ apiKey: "k", fetchFn }).buildRoutes(request())).toMatchObject({ ok: false, reason: "unavailable" });
    }
  });

  it("never exposes the key in a result, even when the network error names the URL", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED https://routing.api.2gis.com/routing/7.0.0/global?key=SECRET-KEY-123"));
    const result = await createTwoGisProvider({ apiKey: "SECRET-KEY-123", fetchFn }).buildRoutes(request());
    expect(JSON.stringify(result)).not.toContain("SECRET-KEY-123");
  });

  it("maps a rejected key", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ meta: { code: 403 } }, 403));
    expect(await createTwoGisProvider({ apiKey: "k", fetchFn }).buildRoutes(request())).toMatchObject({ ok: false, reason: "key_rejected" });
  });
});
