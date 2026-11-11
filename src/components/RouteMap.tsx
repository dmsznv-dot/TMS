"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { FeatureGroup, Map as LeafletMap } from "leaflet";

export type MapStop = { lat: number; lon: number; label: string };

type Props = {
  stops: MapStop[];
  /** Polylines of [lat, lon] for the chosen variant; nothing is drawn when absent. */
  lines: [number, number][][] | null;
  tileUrl: string;
};

/** Stops of the trip and, once a route is calculated, its line. */
export function RouteMap({ stops, lines, tileUrl }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layer = useRef<FeatureGroup | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current || map.current) return;
      const instance = L.map(container.current).setView([55.0302, 82.9204], 10);
      L.tileLayer(tileUrl, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(instance);
      layer.current = L.featureGroup().addTo(instance);
      map.current = instance;
      draw();
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      layer.current = null;
    };
    // The map is created once per tile source; drawing is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileUrl]);

  function draw() {
    void import("leaflet").then((L) => {
      const instance = map.current;
      const group = layer.current;
      if (!instance || !group) return;
      group.clearLayers();
      for (const line of lines ?? []) L.polyline(line, { color: "#2563eb", weight: 4, opacity: 0.8 }).addTo(group);
      stops.forEach((s, i) => {
        L.circleMarker([s.lat, s.lon], { radius: 9, color: "#1d4ed8", fillColor: "#fff", fillOpacity: 1, weight: 3 })
          .bindTooltip(`${i + 1}`, { permanent: true, direction: "center", className: "route-stop-label" })
          .bindPopup(s.label)
          .addTo(group);
      });
      if (group.getLayers().length > 0) instance.fitBounds(group.getBounds().pad(0.15), { maxZoom: 14 });
    });
  }

  useEffect(draw, [stops, lines]);

  return (
    <div
      ref={container}
      data-testid="route-map"
      className="h-72 w-full rounded-md border border-gray-300"
      aria-label="Карта рейса"
    />
  );
}
