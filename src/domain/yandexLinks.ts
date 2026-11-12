import type { LatLon } from "./geo";

function need(points: LatLon[]): void {
  if (points.length < 2) throw new Error("A route needs at least two points");
}

/** Up to six decimals, without trailing zeros. */
const coord = (n: number) => String(Number(n.toFixed(6)));

/**
 * Yandex Maps route through all points, by car. Yandex may choose another
 * path and does not know the truck profile, so this is for orientation.
 */
export function yandexMapsRouteUrl(points: LatLon[]): string {
  need(points);
  const rtext = points.map((p) => `${encodeURIComponent(`${coord(p.lat)},${coord(p.lon)}`)}`).join("~");
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=auto`;
}

/**
 * Yandex Navigator link: from the first point to the last, with the points
 * between them as lat_via_N / lon_via_N.
 */
export function yandexNavigatorUrl(points: LatLon[]): string {
  need(points);
  const first = points[0];
  const last = points[points.length - 1];
  const params = [
    `lat_from=${coord(first.lat)}`,
    `lon_from=${coord(first.lon)}`,
    `lat_to=${coord(last.lat)}`,
    `lon_to=${coord(last.lon)}`,
  ];
  points.slice(1, -1).forEach((p, i) => params.push(`lat_via_${i}=${coord(p.lat)}`, `lon_via_${i}=${coord(p.lon)}`));
  return `yandexnavi://build_route_on_map?${params.join("&")}`;
}
