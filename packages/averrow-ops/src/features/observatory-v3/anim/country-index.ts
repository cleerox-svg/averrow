/**
 * Stable country index.
 *
 * deck.gl transitions (and any binary-attribute data) match old and new values
 * BY INDEX. A fixed, sorted list of ISO-2 codes means "country X" occupies the
 * same slot in every dataset, so a bar/dot/choropleth for a country animates
 * smoothly between updates even when the set of countries that have data
 * changes. Fill absent countries with a zero/neutral value instead of dropping
 * the slot.
 *
 * The order is derived from COUNTRY_CENTROIDS (sorted), so it is stable for the
 * lifetime of a build/session — indices are NOT a persistence format.
 */

import { COUNTRY_CENTROIDS, type LngLat } from '@/lib/country-centroids';

/** ISO-2 codes, sorted A–Z. */
export const COUNTRY_CODES: readonly string[] = Object.freeze(Object.keys(COUNTRY_CENTROIDS).sort());

export const COUNTRY_COUNT = COUNTRY_CODES.length;

const INDEX_BY_CODE: ReadonlyMap<string, number> = new Map(COUNTRY_CODES.map((c, i) => [c, i]));

/** Flat [lng, lat, lng, lat, …] for binary `getPosition` attributes (size 2). */
export const COUNTRY_POSITIONS: Float32Array = (() => {
  const out = new Float32Array(COUNTRY_COUNT * 2);
  COUNTRY_CODES.forEach((code, i) => {
    const c = COUNTRY_CENTROIDS[code]!;
    out[i * 2] = c[0];
    out[i * 2 + 1] = c[1];
  });
  return out;
})();

/** Slot for an ISO-2 code (case-insensitive), or -1 if unknown. */
export function countryIndex(code: string | null | undefined): number {
  if (!code) return -1;
  return INDEX_BY_CODE.get(code.trim().toUpperCase()) ?? -1;
}

export function countryCodeAt(index: number): string | null {
  return COUNTRY_CODES[index] ?? null;
}

export function countryCentroidAt(index: number): LngLat | null {
  if (index < 0 || index >= COUNTRY_COUNT) return null;
  return [COUNTRY_POSITIONS[index * 2]!, COUNTRY_POSITIONS[index * 2 + 1]!];
}

/**
 * Index-stable value array: one slot per country, `fallback` where `values` has
 * no entry. Unknown codes in `values` are ignored.
 */
export function countryValueArray<T>(
  values: ReadonlyMap<string, T> | Readonly<Record<string, T>>, fallback: T,
): T[] {
  const get = values instanceof Map
    ? (code: string) => values.get(code)
    : (code: string) => (values as Readonly<Record<string, T>>)[code];
  return COUNTRY_CODES.map(code => get(code) ?? fallback);
}
