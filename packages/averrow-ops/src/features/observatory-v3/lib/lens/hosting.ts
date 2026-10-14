/**
 * Hosting lens model: hosting providers as rings at their country centroid.
 *
 *  - radius ∝ √(active threats); the biggest provider claims the centroid and
 *    the rest of that country's providers spread on a spiral (deterministic),
 *  - fill by 7-day trend against the provider's own 30-day weekly run-rate,
 *  - bulletproof hosts get an animated dashed halo,
 *  - the takedown arc (share of resolved takedowns that were taken down) draws
 *    only when the provider has takedown data (the server sends null otherwise).
 */

import type { ProviderGeo } from '@/hooks/useObservatoryLenses';
import type { LngLat } from '@/lib/country-centroids';
import type { Rgba } from '../map-colors';
import { countryCenter, groupIndexes, groupSizes, iso2, placeAround, stepFor } from './placement';

export type TrendClass = 'rising' | 'falling' | 'flat';

export interface ProviderRing {
  id: string;
  name: string;
  asn: string | null;
  country: string;
  position: LngLat;
  active: number;
  total: number;
  trend7: number;
  trend30: number;
  trend: TrendClass;
  bulletproof: boolean;
  /** 0..1 success share of resolved takedowns, or null (no data / nothing resolved). */
  takedownShare: number | null;
  takedownN: number;
  medianHours: number | null;
  reputation: number | null;
  radiusPx: number;
}

export interface HostingModel {
  rings: ProviderRing[];
  /** Providers dropped for having no placeable country. */
  unplaced: number;
  byId: Map<string, ProviderRing>;
  maxActive: number;
}

/** Providers spread on a spiral round their country centroid but never further than this (degrees): rings stay over their country. */
export const MAX_SPREAD_DEG = 4;
export const SPREAD_STEP_DEG = 2.6;
export const RING_MIN_PX = 7;
export const RING_MAX_PX = 30;

/** Weekly run-rate implied by the 30-day count. */
export function weeklyRunRate(trend30: number): number {
  return (trend30 * 7) / 30;
}

/**
 * Rising when this week is clearly above the 30-day weekly run-rate, falling
 * when clearly below. "Clearly" = beyond ±25% and at least 2 threats, so a
 * provider going 1 → 2 doesn't light up red.
 */
export function trendClass(trend7: number, trend30: number): TrendClass {
  const expected = weeklyRunRate(trend30);
  const delta = trend7 - expected;
  const margin = Math.max(2, expected * 0.25);
  if (delta > margin) return 'rising';
  if (delta < -margin) return 'falling';
  return 'flat';
}

export const TREND_COLORS: Record<TrendClass, Rgba> = {
  rising: [248, 113, 113, 255],
  falling: [60, 184, 120, 255],
  flat: [96, 165, 250, 255],
};

export function ringRadiusPx(active: number, maxActive: number): number {
  if (maxActive <= 0) return RING_MIN_PX;
  const f = Math.sqrt(Math.max(0, active) / maxActive);
  return RING_MIN_PX + (RING_MAX_PX - RING_MIN_PX) * Math.min(1, f);
}

export function buildHostingModel(providers: readonly ProviderGeo[]): HostingModel {
  // Providers with nothing active and not flagged bulletproof carry no signal here.
  const relevant = providers
    .filter(p => p.active_threat_count > 0 || p.is_bulletproof)
    .sort((a, b) => b.active_threat_count - a.active_threat_count || a.id.localeCompare(b.id));

  let unplaced = 0;
  const placeable: Array<{ p: ProviderGeo; cc: string }> = [];
  for (const p of relevant) {
    const cc = iso2(p.country);
    if (!cc || !countryCenter(cc)) { unplaced++; continue; }
    placeable.push({ p, cc });
  }
  const maxActive = placeable.reduce((m, e) => Math.max(m, e.p.active_threat_count), 0);
  const idx = groupIndexes(placeable, e => e.cc);
  const sizes = groupSizes(placeable, e => e.cc);
  const rings = placeable.map(({ p, cc }, i): ProviderRing => ({
    id: p.id,
    name: p.name,
    asn: p.asn,
    country: cc,
    position: placeAround(countryCenter(cc)!, idx[i]!, stepFor(sizes[i]!, SPREAD_STEP_DEG, MAX_SPREAD_DEG), MAX_SPREAD_DEG),
    active: p.active_threat_count,
    total: p.total_threat_count,
    trend7: p.trend_7d,
    trend30: p.trend_30d,
    trend: trendClass(p.trend_7d, p.trend_30d),
    bulletproof: p.is_bulletproof,
    takedownShare: p.takedown && typeof p.takedown.share === 'number' ? Math.max(0, Math.min(1, p.takedown.share)) : null,
    takedownN: p.takedown?.n ?? 0,
    medianHours: p.takedown?.median_hours ?? null,
    reputation: p.reputation_score,
    radiusPx: ringRadiusPx(p.active_threat_count, maxActive),
  }));
  return { rings, unplaced, byId: new Map(rings.map(r => [r.id, r])), maxActive };
}
