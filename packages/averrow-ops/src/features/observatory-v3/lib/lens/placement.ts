/**
 * Placing country-level data on the map.
 *
 * Several lens objects often share one country (providers, operation nodes).
 * Stacking them on the centroid hides all but one, so extra items are spread on
 * a deterministic golden-angle spiral around it: same input, same positions, no
 * jitter between refetches.
 */

import { getCountryCentroid, type LngLat } from '@/lib/country-centroids';

const GOLDEN_ANGLE = 2.399963229728653;

/** Spiral offset in degrees for the k-th item (k = 0 is the centre). */
export function spreadOffset(index: number, step: number): [number, number] {
  if (index <= 0) return [0, 0];
  const angle = index * GOLDEN_ANGLE;
  const r = step * Math.sqrt(index);
  return [r * Math.cos(angle), r * Math.sin(angle)];
}

/**
 * Spiral step that keeps a group of `count` items inside `maxRadius` degrees of the
 * centre. A country with 30 providers must not scatter them into the next country:
 * the spiral tightens (rings overlap, which is honest) instead of growing.
 */
export function stepFor(count: number, step: number, maxRadius: number): number {
  if (count <= 1) return step;
  return Math.min(step, maxRadius / Math.sqrt(count - 1));
}

/** Position of the `index`-th item around a centre (longitude stretched at high latitude, latitude clamped). */
export function placeAround(center: LngLat, index: number, step = 1.1, maxRadius = Infinity): LngLat {
  let [dx, dy] = spreadOffset(index, step);
  const r = Math.hypot(dx, dy);
  if (r > maxRadius) { dx *= maxRadius / r; dy *= maxRadius / r; }
  const lngScale = 1 / Math.max(Math.cos((center[1] * Math.PI) / 180), 0.35);
  const lat = Math.max(-80, Math.min(80, center[1] + dy));
  let lng = center[0] + dx * lngScale;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return [lng, lat];
}

export function countryCenter(code: string | null | undefined): LngLat | null {
  const c = getCountryCentroid(code);
  return c && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null;
}

/** Size of each item's group (same order as the input). */
export function groupSizes<T>(items: readonly T[], keyOf: (item: T) => string): number[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return items.map(item => counts.get(keyOf(item))!);
}

/**
 * Per-item index within its group, in input order (so callers sort first for a
 * meaningful "biggest in the middle" layout).
 */
export function groupIndexes<T>(items: readonly T[], keyOf: (item: T) => string): number[] {
  const seen = new Map<string, number>();
  return items.map(item => {
    const k = keyOf(item);
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    return i;
  });
}

/** Normalise an ISO-2 code from the API (case, whitespace); null when it isn't one. */
export function iso2(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}
