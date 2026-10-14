/**
 * Threats lens, "Fast weaponization" view: countries where domains went live within
 * days of being registered (`/velocity-nodes`, from the heal-only velocity cube).
 *
 *  - one node per country at its centroid, radius ∝ √(very_fast + fast),
 *  - a colour of its own (indigo) that no severity, threat type or other lens uses:
 *    fast weaponization is evidence about an operator, not a severity,
 *  - very-fast nodes (registered -> live inside a day) pulse, fast-only ones are still.
 *
 * The cube is filled by cube_healer, not by ingest, so an empty answer means coverage
 * is still filling: the copy says so (`VELOCITY_FILLING`), never "none".
 */

import type { VelocityNode } from '@/hooks/useObservatoryLenses';
import type { LngLat } from '@/lib/country-centroids';
import type { Rgba } from '../map-colors';
import { phaseForKey } from '../../anim';
import { iso2 } from './placement';

/**
 * Indigo (hue ~240): the widest gap left on a palette that already spends red, orange, yellow, lime, emerald, cyan,
 * blue, violet, magenta and pink on severities and threat types. Readable on the dark basemap and on the light card.
 */
export const VELOCITY_COLOR: Rgba = [118, 120, 255, 255];
export const VELOCITY_RGB = 'rgb(118, 120, 255)';

export const VELOCITY_MIN_PX = 5;
export const VELOCITY_MAX_PX = 19;

/** Copy for an empty answer: the cube fills after cube_healer runs, so "none yet" would be wrong. */
export const VELOCITY_FILLING =
  'Velocity coverage is still filling. This view is built by the cube healer after ingest, so recent threats may not appear yet.';

export interface VelocityPoint {
  cc: string;
  position: LngLat;
  veryFast: number;
  fast: number;
  /** very_fast + fast. */
  count: number;
  /** Registered -> live inside a day: these pulse. */
  hot: boolean;
  radiusPx: number;
  phase: number;
}

export interface VelocityModel {
  points: VelocityPoint[];
  byCc: Map<string, VelocityPoint>;
  veryFast: number;
  fast: number;
  total: number;
  max: number;
  /** Fast counts dropped by the server for lacking a placeable country. */
  dropped: number;
}

export function velocityRadiusPx(count: number, max: number): number {
  if (!(max > 0) || !(count > 0)) return VELOCITY_MIN_PX;
  return VELOCITY_MIN_PX + (VELOCITY_MAX_PX - VELOCITY_MIN_PX) * Math.min(1, Math.sqrt(count / max));
}

export function buildVelocityModel(nodes: readonly VelocityNode[], dropped = 0): VelocityModel {
  const rows: Array<{ cc: string; position: LngLat; veryFast: number; fast: number }> = [];
  for (const n of nodes) {
    const cc = iso2(n.country_code);
    const veryFast = Math.max(0, Number(n.very_fast) || 0);
    const fast = Math.max(0, Number(n.fast) || 0);
    if (!cc || !Number.isFinite(n.lat) || !Number.isFinite(n.lng) || veryFast + fast <= 0) continue;
    rows.push({ cc, position: [n.lng, n.lat], veryFast, fast });
  }
  const max = rows.reduce((m, r) => Math.max(m, r.veryFast + r.fast), 0);
  const points = rows
    .map((r): VelocityPoint => ({
      ...r,
      count: r.veryFast + r.fast,
      hot: r.veryFast > 0,
      radiusPx: velocityRadiusPx(r.veryFast + r.fast, max),
      phase: phaseForKey(r.cc),
    }))
    .sort((a, b) => b.count - a.count || a.cc.localeCompare(b.cc));
  return {
    points,
    byCc: new Map(points.map(p => [p.cc, p])),
    veryFast: points.reduce((s, p) => s + p.veryFast, 0),
    fast: points.reduce((s, p) => s + p.fast, 0),
    total: points.reduce((s, p) => s + p.count, 0),
    max,
    dropped: Math.max(0, dropped),
  };
}
