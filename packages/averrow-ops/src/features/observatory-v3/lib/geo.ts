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
