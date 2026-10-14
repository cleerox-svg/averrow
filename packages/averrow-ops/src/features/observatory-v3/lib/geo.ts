/**
 * Position validity for map data. `0` is a legitimate latitude / longitude
 * (the equator, the prime meridian — Accra, London-Greenwich), so a truthiness
 * check drops real cells. Only non-finite values and the exact (0, 0) "null
 * island" sentinel (an un-geolocated row) are excluded.
 */

import type { ArcData } from '@/hooks/useObservatory';

export function hasValidPosition(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function hasValidPoint(p: { lat: number; lng: number }): boolean {
  return hasValidPosition(p.lat, p.lng);
}

/** Arc endpoints are [lng, lat]. Both must be placeable. */
export function hasValidArc(a: Pick<ArcData, 'sourcePosition' | 'targetPosition'>): boolean {
  return (
    Array.isArray(a.sourcePosition) && Array.isArray(a.targetPosition) &&
    hasValidPosition(a.sourcePosition[1], a.sourcePosition[0]) &&
    hasValidPosition(a.targetPosition[1], a.targetPosition[0])
  );
}

/** Width of the whole world in CSS px at a MapLibre zoom (512px tiles). */
export function worldPixels(zoom: number): number {
  return 512 * 2 ** zoom;
}

/**
 * Longitude to move the map CENTRE by so that a point lands `dxPx` pixels to the
 * right of the centre of the viewport (Mercator longitude is linear in x). The
 * console overlays the map with a left rail and a right drawer; the free area's
 * centre is offset from the map's by (left - right) / 2.
 */
export function lngShiftForPixels(dxPx: number, zoom: number): number {
  if (!Number.isFinite(dxPx) || !Number.isFinite(zoom)) return 0;
  return (dxPx / worldPixels(zoom)) * 360;
}

/** Camera centre longitude that puts `lng` at the middle of the area left free by the overlays. */
export function centerLngForFreeArea(lng: number, leftInset: number, rightInset: number, zoom: number): number {
  const dx = ((Number.isFinite(leftInset) ? leftInset : 0) - (Number.isFinite(rightInset) ? rightInset : 0)) / 2;
  return lng - lngShiftForPixels(dx, zoom);
}
