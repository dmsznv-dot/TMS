"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { CircleMarker, Map as LeafletMap } from "leaflet";

type Props = {
  lat: number | null;
  lon: number | null;
  tileUrl: string;
  onChange(lat: number, lon: number): void;
};

/** Novosibirsk city centre: the initial view when no point is set. */
const DEFAULT_CENTER: [number, number] = [55.0302, 82.9204];

/** A map where a click sets the coordinates of a point. */
export function MapPicker({ lat, lon, tileUrl, onChange }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<CircleMarker | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current || map.current) return;
      const instance = L.map(container.current).setView(DEFAULT_CENTER, 11);
      L.tileLayer(tileUrl, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(instance);
      instance.on("click", (e) => {
        onChangeRef.current(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6)));
      });
      map.current = instance;
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      marker.current = null;
    };
  }, [tileUrl]);

  useEffect(() => {
    void import("leaflet").then((L) => {
      const instance = map.current;
      if (!instance) return;
      if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
        marker.current?.remove();
        marker.current = null;
        return;
      }
      if (marker.current) marker.current.setLatLng([lat, lon]);
      else marker.current = L.circleMarker([lat, lon], { radius: 8, color: "#2563eb" }).addTo(instance);
      instance.panTo([lat, lon]);
    });
  }, [lat, lon]);

  return (
    <div
      ref={container}
      data-testid="map-picker"
      className="h-64 w-full rounded-md border border-gray-300"
      aria-label="Карта: клик задаёт координаты точки"
    />
  );
}
