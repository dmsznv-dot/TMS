import { describe, expect, it } from "vitest";
import { yandexMapsRouteUrl, yandexNavigatorUrl } from "./yandexLinks";

const A = { lat: 55.0302, lon: 82.9204 };
const B = { lat: 55.06, lon: 82.95 };
const C = { lat: 54.9472, lon: 82.9033 };

describe("yandexMapsRouteUrl", () => {
  it("lists the points as lat,lon separated by ~ and asks for a car route", () => {
    expect(yandexMapsRouteUrl([A, B])).toBe("https://yandex.ru/maps/?rtext=55.0302%2C82.9204~55.06%2C82.95&rtt=auto");
  });
  it("keeps the order of intermediate stops", () => {
    expect(yandexMapsRouteUrl([A, B, C])).toBe(
      "https://yandex.ru/maps/?rtext=55.0302%2C82.9204~55.06%2C82.95~54.9472%2C82.9033&rtt=auto",
    );
  });
  it("trims coordinates to six decimals", () => {
    expect(yandexMapsRouteUrl([{ lat: 55.123456789, lon: 82.1 }, B])).toContain("55.123457%2C82.1~");
  });
  it("needs at least two points", () => {
    expect(() => yandexMapsRouteUrl([A])).toThrow();
  });
});

describe("yandexNavigatorUrl", () => {
  it("builds a route from the first to the last point", () => {
    expect(yandexNavigatorUrl([A, B])).toBe(
      "yandexnavi://build_route_on_map?lat_from=55.0302&lon_from=82.9204&lat_to=55.06&lon_to=82.95",
    );
  });
  it("passes the points between them as numbered via points", () => {
    expect(yandexNavigatorUrl([A, B, C])).toBe(
      "yandexnavi://build_route_on_map?lat_from=55.0302&lon_from=82.9204&lat_to=54.9472&lon_to=82.9033&lat_via_0=55.06&lon_via_0=82.95",
    );
  });
  it("numbers several via points from zero", () => {
    const url = yandexNavigatorUrl([A, B, C, A]);
    expect(url).toContain("lat_via_0=55.06&lon_via_0=82.95");
    expect(url).toContain("lat_via_1=54.9472&lon_via_1=82.9033");
  });
  it("needs at least two points", () => {
    expect(() => yandexNavigatorUrl([])).toThrow();
  });
});
