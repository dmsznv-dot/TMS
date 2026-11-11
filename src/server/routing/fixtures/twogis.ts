// Hand-written responses that follow the shape documented for
// POST /routing/7.0.0/global. They are not recordings of real answers:
// the service terms do not allow storing 2GIS responses.

const maneuver = (comment: string, distance: number, duration: number, selection: string) => ({
  comment,
  outcoming_path: {
    distance,
    duration,
    geometry: [{ length: distance, selection }],
  },
  outcoming_path_comment: `${distance} м прямо`,
  type: comment === "start" ? "begin" : "crossroad",
});

/** Two variants for a two-point route. Coordinates are "lon lat [height]". */
export function twoVariantsResponse() {
  return {
    message: null,
    query: { locale: "ru", output: "detailed", transport: "truck" },
    status: "OK",
    type: "result",
    result: [
      {
        id: "6157325219231242068",
        algorithm: "с учётом пробок",
        total_distance: 5904,
        total_duration: 1099,
        ui_total_distance: { unit: "км", value: "5.9" },
        ui_total_duration: "18 мин",
        type: "truckrouting",
        begin_pedestrian_path: { geometry: { selection: "LINESTRING(82.9204 55.0302, 82.9206 55.0303)" } },
        end_pedestrian_path: { geometry: { selection: "LINESTRING(82.9500 55.0600, 82.9502 55.0601)" } },
        maneuvers: [
          maneuver("start", 3000, 600, "LINESTRING(82.9206 55.0303 120, 82.9300 55.0400 121, 82.9400 55.0500 125)"),
          maneuver("crossroad", 2904, 499, "LINESTRING(82.9400 55.0500 125, 82.9500 55.0600 130)"),
          { comment: "end", type: "end" },
        ],
      },
      {
        id: "6157325219231242069",
        algorithm: "с учётом пробок",
        total_distance: 6400,
        total_duration: 1180,
        type: "truckrouting",
        maneuvers: [maneuver("start", 6400, 1180, "LINESTRING(82.9206 55.0303, 82.9500 55.0600)")],
      },
    ],
  };
}

export const NOT_FOUND = { status: "ROUTE_NOT_FOUND", type: "error", message: "Маршрут не найден", result: [] };
