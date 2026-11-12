import { describe, expect, it } from "vitest";
import { parseLineStringWkt } from "./wkt";

describe("parseLineStringWkt", () => {
  it("returns [lat, lon] pairs from lon-lat text", () => {
    expect(parseLineStringWkt("LINESTRING(82.9204 55.0302, 82.9210 55.0305)")).toEqual([
      [55.0302, 82.9204],
      [55.0305, 82.921],
    ]);
  });
  it("drops the height of three-dimensional points", () => {
    expect(parseLineStringWkt("LINESTRING(82.93 55.04 120, 82.94 55.05 125)")).toEqual([
      [55.04, 82.93],
      [55.05, 82.94],
    ]);
  });
  it("accepts negative coordinates and extra spaces", () => {
    expect(parseLineStringWkt("  LINESTRING( -1.5  2.5 ,3 4 )")).toEqual([
      [2.5, -1.5],
      [4, 3],
    ]);
  });
  it("returns nothing for text that is not a line", () => {
    expect(parseLineStringWkt("POINT(1 2)")).toEqual([]);
    expect(parseLineStringWkt("")).toEqual([]);
    expect(parseLineStringWkt("LINESTRING()")).toEqual([]);
  });
  it("skips malformed points but keeps valid ones", () => {
    expect(parseLineStringWkt("LINESTRING(1 2, abc def, 3 4)")).toEqual([
      [2, 1],
      [4, 3],
    ]);
  });
});
