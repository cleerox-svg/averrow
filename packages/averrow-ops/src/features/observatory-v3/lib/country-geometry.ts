/**
 * Country polygons for the Baseline choropleth.
 *
 * Natural Earth 110m admin-0 (public domain), via world-atlas, flattened to a
 * GeoJSON FeatureCollection keyed by ISO-2 `id`, coordinates rounded to 0.1° and
 * Antarctica dropped (~140 kB raw). It is NOT in the JS bundle: Vite emits it as
 * a hashed static asset (`?url`) that is fetched only the first time the Baseline
 * layer is switched on, then kept for the session.
 */

import { useEffect, useState } from 'react';
import countriesUrl from '../data/countries-110m.json?url';
import type { CountryCollection } from '../layers/lens-layers';

let cache: Promise<CountryCollection> | null = null;

export function isCountryCollection(v: unknown): v is CountryCollection {
  if (!v || typeof v !== 'object') return false;
  const fc = v as { type?: unknown; features?: unknown };
  return fc.type === 'FeatureCollection' && Array.isArray(fc.features) && fc.features.length > 0;
}

export function loadCountryGeometry(fetchImpl: typeof fetch = fetch): Promise<CountryCollection> {
  if (!cache) {
    cache = fetchImpl(countriesUrl)
      .then(res => {
        if (!res.ok) throw new Error(`Country geometry request failed: ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then(json => {
        if (!isCountryCollection(json)) throw new Error('Country geometry is malformed');
        return json;
      })
      .catch((err: unknown) => {
        cache = null; // a failed load can be retried
        throw err;
      });
  }
  return cache;
}

/** Test seam. */
export function resetCountryGeometryCache(): void {
  cache = null;
}

export interface CountryGeometryState {
  countries: CountryCollection | null;
  error: Error | null;
}

export function useCountryGeometry(enabled: boolean): CountryGeometryState {
  const [state, setState] = useState<CountryGeometryState>({ countries: null, error: null });
  useEffect(() => {
    if (!enabled || state.countries) return;
    let live = true;
    loadCountryGeometry().then(
      countries => { if (live) setState({ countries, error: null }); },
      (error: unknown) => { if (live) setState({ countries: null, error: error instanceof Error ? error : new Error(String(error)) }); },
    );
    return () => { live = false; };
  }, [enabled, state.countries]);
  return state;
}
