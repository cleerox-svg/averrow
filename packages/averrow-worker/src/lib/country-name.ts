/**
 * ISO 3166-1 alpha-2 code → English display name, via Intl.DisplayNames (no
 * data table shipped). Falls back to the upper-cased code when the runtime
 * has no region names or the code is unknown.
 *
 * Worker copy of `packages/averrow-ops/src/features/observatory-v3/lib/country-name.ts`
 * (the Worker cannot import from the SPA package), so server-written copy
 * (e.g. the Observatory event rail titles) names a country exactly as the
 * map's own labels do. Keep the two in sync; consolidating them into
 * `@averrow/shared` is the same tracked follow-up as lib/country-centroids.ts.
 */

const cache = new Map<string, string>();
let display: Intl.DisplayNames | null | undefined;

function names(): Intl.DisplayNames | null {
  if (display !== undefined) return display;
  try {
    display = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    display = null;
  }
  return display;
}

export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  const cc = code.trim().toUpperCase();
  const hit = cache.get(cc);
  if (hit) return hit;
  let name = cc;
  try {
    const n = names()?.of(cc);
    if (n && n !== cc) name = n;
  } catch {
    /* invalid region code */
  }
  cache.set(cc, name);
  return name;
}
