/**
 * Reads "LINESTRING(lon lat [height], ...)" into [lat, lon] pairs.
 * Malformed points are skipped; text that is not a line gives an empty list.
 */
export function parseLineStringWkt(text: string): [number, number][] {
  const match = /^\s*LINESTRING\s*\(([^)]*)\)\s*$/i.exec(text);
  if (!match) return [];
  const points: [number, number][] = [];
  for (const part of match[1].split(",")) {
    const [lon, lat] = part.trim().split(/\s+/).map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lat, lon]);
  }
  return points;
}
