/**
 * Takedown outcomes (`/takedowns-geo`, requires `manage_takedowns`):
 *
 *   Baseline > Takedowns  (by=country)   a choropleth of the takedown SUCCESS share
 *   Hosting  > Takedowns  (by=provider)  the hosting rings coloured by the same share
 *
 * success share = taken_down / (taken_down + refused + expired), computed by the server.
 * It is only a rate once enough takedowns have RESOLVED: a country with 2 resolved
 * takedowns at 100% is not "the best jurisdiction". Under TAKEDOWN_MIN_RESOLVED the
 * share is drawn grey (never coloured, never ranked) and the tooltip says why.
 *
 * Scale: sequential green, dark (hard: most requests refused or ignored) to bright
 * (they take it down). Sequential, not diverging: there is no neutral midpoint, and
 * red would read as "attack", which this is not.
 */

import type { TakedownGeoRow } from '@/hooks/useObservatoryLenses';
import type { Rgba } from '../map-colors';
import { lerpStops } from './baseline';
import { iso2 } from './placement';
import type { HostingModel, ProviderRing } from './hosting';

/** Fewer resolved takedowns than this and the share is noise: grey, and left out of rankings. */
export const TAKEDOWN_MIN_RESOLVED = 5;

export const TAKEDOWN_STOPS: ReadonlyArray<{ t: number; color: Rgba }> = [
  { t: 0, color: [22, 78, 62, 175] },
  { t: 0.5, color: [38, 150, 100, 205] },
  { t: 1, color: [110, 231, 160, 240] },
];

/** Too few resolved takedowns to call a rate. */
export const TAKEDOWN_SMALL_COLOR: Rgba = [148, 163, 184, 70];
export const TAKEDOWN_SMALL_OUTLINE: Rgba = [148, 163, 184, 150];

export const resolvedOf = (r: Pick<TakedownGeoRow, 'taken_down' | 'refused' | 'expired'>): number =>
  (r.taken_down || 0) + (r.refused || 0) + (r.expired || 0);

/** Has the row enough resolved takedowns for its share to mean something? */
export function hasRate(r: TakedownGeoRow): boolean {
  return typeof r.share === 'number' && Number.isFinite(r.share) && resolvedOf(r) >= TAKEDOWN_MIN_RESOLVED;
}

export function takedownColor(r: TakedownGeoRow): Rgba {
  if (!hasRate(r)) return TAKEDOWN_SMALL_COLOR;
  return lerpStops(TAKEDOWN_STOPS, Math.min(1, Math.max(0, r.share as number)));
}

/** Hardest first: lowest success share, then the bigger sample (a 20% on 80 requests outranks a 20% on 6). */
export function rankHardest(rows: readonly TakedownGeoRow[]): TakedownGeoRow[] {
  return rows
    .filter(hasRate)
    .sort((a, b) => (a.share as number) - (b.share as number) || resolvedOf(b) - resolvedOf(a) || a.key.localeCompare(b.key));
}

export const pct = (share: number): string => `${Math.round(share * 100)}%`;

export function formatHours(h: number | null): string | null {
  if (h === null || !Number.isFinite(h)) return null;
  return h >= 48 ? `${(h / 24).toFixed(h >= 240 ? 0 : 1)}d` : `${Math.round(h)}h`;
}

/** The three lines a tooltip / drawer states for a row. */
export function takedownFacts(r: TakedownGeoRow): string[] {
  const resolved = resolvedOf(r);
  const median = formatHours(r.median_hours);
  const rate = hasRate(r)
    ? `${pct(r.share as number)} taken down`
    : `too few resolved (${resolved} of ${TAKEDOWN_MIN_RESOLVED} needed)`;
  return [rate, `${r.submitted.toLocaleString()} submitted · ${resolved.toLocaleString()} resolved`, ...(median ? [`median ${median} to take down`] : [])];
}

// ─── Countries (Baseline) ───────────────────────────────────

export interface TakedownCountryModel {
  rows: Map<string, TakedownGeoRow>;
  /** Per-country fill (countries with a row only; the rest stay unfilled). */
  colors: Map<string, Rgba>;
  /** Countries whose sample is too small for a rate (outlined grey). */
  small: Set<string>;
  /** Lowest success share first, enough volume only. */
  hardest: TakedownGeoRow[];
  withRate: number;
  tooSmall: number;
  submitted: number;
  /** Takedowns whose source country is unknown (not on the map). */
  unknownSubmitted: number;
}

export function buildTakedownCountryModel(rows: readonly TakedownGeoRow[]): TakedownCountryModel {
  const byCc = new Map<string, TakedownGeoRow>();
  let unknownSubmitted = 0;
  let submitted = 0;
  for (const r of rows) {
    submitted += r.submitted || 0;
    const cc = iso2(r.key);
    if (!cc) { unknownSubmitted += r.submitted || 0; continue; }
    byCc.set(cc, r.key === cc ? r : { ...r, key: cc }); // downstream (map ids, drill targets) use the upper-case code
  }
  const colors = new Map<string, Rgba>();
  const small = new Set<string>();
  for (const [cc, r] of byCc) {
    colors.set(cc, takedownColor(r));
    if (!hasRate(r)) small.add(cc);
  }
  return {
    rows: byCc, colors, small,
    hardest: rankHardest([...byCc.values()]),
    withRate: byCc.size - small.size, tooSmall: small.size,
    submitted, unknownSubmitted,
  };
}

// ─── Providers (Hosting) ────────────────────────────────────

export interface TakedownProviderModel {
  /** The hosting model with each ring's takedown fields taken from /takedowns-geo (same window as the colours). */
  hosting: HostingModel;
  /** Ring id -> fill. */
  colors: Map<string, Rgba>;
  rows: Map<string, TakedownGeoRow>;
  hardest: TakedownGeoRow[];
  /** Rows with a takedown history whose provider has no ring (no active threats / no country): listed, not drawn. */
  undrawn: number;
  withRate: number;
  tooSmall: number;
}

export function buildTakedownProviderModel(hosting: HostingModel, rows: readonly TakedownGeoRow[]): TakedownProviderModel {
  const byId = new Map(rows.map(r => [r.key, r] as const));
  const colors = new Map<string, Rgba>();
  const rings = hosting.rings.map((ring): ProviderRing => {
    const r = byId.get(ring.id);
    colors.set(ring.id, r ? takedownColor(r) : TAKEDOWN_SMALL_COLOR);
    if (!r) return { ...ring, takedownShare: null, takedownN: 0, medianHours: null };
    return {
      ...ring,
      takedownShare: hasRate(r) ? Math.max(0, Math.min(1, r.share as number)) : null,
      takedownN: r.submitted,
      medianHours: r.median_hours,
    };
  });
  const drawn = new Set(hosting.rings.map(r => r.id));
  const real = rows.filter(r => r.key !== 'unknown');
  return {
    hosting: { ...hosting, rings, byId: new Map(rings.map(r => [r.id, r])) },
    colors,
    rows: byId,
    hardest: rankHardest(real),
    undrawn: real.filter(r => !drawn.has(r.key)).length,
    withRate: real.filter(hasRate).length,
    tooSmall: real.filter(r => !hasRate(r)).length,
  };
}
