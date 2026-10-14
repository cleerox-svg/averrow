/**
 * Particle ("trips") + beam geometry for the Observatory map.
 *
 * Timeline replay model: the selected period is mapped onto CYCLE_LENGTH. Each
 * arc has a "life window" within the cycle matching when its threats occurred,
 * so only ~15-25% of arcs are active at any moment.
 *
 * Pure (no React / deck.gl) so it can be unit-tested.
 */

import type { ArcData } from '@/hooks/useObservatory';
import { parseUtc } from '@/lib/time';
import { getArcColor, type ColorBy, type Rgba } from './map-colors';

/** One full replay of the selected period, in timeline units (60 u/s => 60s). */
export const CYCLE_LENGTH = 3600;
/** Time for one particle to traverse an arc (~3s). */
export const TRIP_SPAN = 180;
export const MIN_LIFE_RATIO = 0.08;
export const MAX_LIFE_RATIO = 0.35;
export const MOBILE_MAX_PARTICLES = 800;
export const DESKTOP_MAX_PARTICLES = 6000;

export interface TripDatum {
  path: [number, number][];
  timestamps: number[];
  color: Rgba;
}

export function trailLengthFor(isMobile: boolean): number {
  return isMobile ? TRIP_SPAN * 0.35 : TRIP_SPAN * 0.5;
}

// ─── Bezier ─────────────────────────────────────────────────

export function computeBezierPath(
  srcLng: number, srcLat: number, tgtLng: number, tgtLat: number, segments = 30,
): [number, number][] {
  const midLng = (srcLng + tgtLng) / 2;
  const midLat = (srcLat + tgtLat) / 2;
  const dist = Math.sqrt((tgtLng - srcLng) ** 2 + (tgtLat - srcLat) ** 2);
  const controlLng = midLng;
  const controlLat = midLat + dist * 0.3;
  const path: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    path.push([
      mt * mt * srcLng + 2 * mt * t * controlLng + t * t * tgtLng,
      mt * mt * srcLat + 2 * mt * t * controlLat + t * t * tgtLat,
    ]);
  }
  return path;
}

const pathCache = new WeakMap<ArcData, [number, number][]>();

/**
 * Bezier path for an arc, memoised on the arc object. TanStack's structural
 * sharing keeps arc objects referentially stable across no-change refetches, so
 * paths are computed once per arc and shared by the beam and particle layers.
 */
export function getArcPath(arc: ArcData): [number, number][] {
  let p = pathCache.get(arc);
  if (!p) {
    p = computeBezierPath(arc.sourcePosition[0], arc.sourcePosition[1], arc.targetPosition[0], arc.targetPosition[1]);
    pathCache.set(arc, p);
  }
  return p;
}

// ─── Life window ────────────────────────────────────────────

function hashArc(arc: ArcData): number {
  const str = `${arc.threat_type ?? ''}|${arc.brand_name ?? arc.target_brand ?? ''}|${arc.sourcePosition[0].toFixed(1)},${arc.sourcePosition[1].toFixed(1)}`;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function computeLifeWindow(
  arc: ArcData, windowStartMs: number, windowEndMs: number,
): { start: number; duration: number } {
  const volumeRatio = Math.min(1, Math.sqrt(arc.volume || 1) / 10);
  const lifeRatio = MIN_LIFE_RATIO + (MAX_LIFE_RATIO - MIN_LIFE_RATIO) * volumeRatio;
  const duration = lifeRatio * CYCLE_LENGTH;

  if (arc.first_seen && arc.last_seen && windowEndMs > windowStartMs) {
    // D1 timestamps are UTC without a zone suffix; parseUtc avoids the local-time misparse.
    const firstMs = parseUtc(arc.first_seen).getTime();
    const lastMs = parseUtc(arc.last_seen).getTime();
    if (Number.isFinite(firstMs) && Number.isFinite(lastMs)) {
      const spanMs = windowEndMs - windowStartMs;
      const startFrac = Math.max(0, Math.min(1, (firstMs - windowStartMs) / spanMs));
      const endFrac = Math.max(0, Math.min(1, (lastMs - windowStartMs) / spanMs));
      const center = (startFrac + endFrac) / 2;
      const start = center * CYCLE_LENGTH - duration / 2;
      return { start: ((start % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH, duration };
    }
  }

  const maxStart = Math.max(1, CYCLE_LENGTH - duration);
  return { start: hashArc(arc) % maxStart, duration };
}

// ─── Trip builder ───────────────────────────────────────────

export function periodToMs(period: string): number {
  switch (period) {
    case '24h': return 24 * 3600_000;
    case '30d': return 30 * 24 * 3600_000;
    case '90d': return 90 * 24 * 3600_000;
    case '7d':
    default: return 7 * 24 * 3600_000;
  }
}

export function buildTripData(
  arcs: ArcData[],
  colorBy: ColorBy,
  isMobile: boolean,
  periodMs: number,
  now: number = Date.now(),
): TripDatum[] {
  const trips: TripDatum[] = [];
  let logical = 0;
  const maxParticles = isMobile ? MOBILE_MAX_PARTICLES : DESKTOP_MAX_PARTICLES;
  const perArcCap = isMobile ? 8 : 15;
  const trail = trailLengthFor(isMobile);
  const windowStart = now - periodMs;

  for (const arc of arcs) {
    if (logical >= maxParticles) break;
    const path = getArcPath(arc);
    const color = getArcColor(arc, colorBy, 220);
    const numParticles = Math.min(Math.max(2, Math.ceil((arc.volume || 1) * 0.6)), perArcCap);
    const { start, duration } = computeLifeWindow(arc, windowStart, now);

    const speed =
      arc.severity === 'critical' ? 1.2 : arc.severity === 'high' ? 1.08 : arc.severity === 'low' ? 0.85 : 1.0;
    const tripSpan = TRIP_SPAN / speed;
    const effectiveDuration = Math.max(TRIP_SPAN, duration - tripSpan);

    // Duplicate each burst half a cycle later so activity is spread evenly
    // regardless of where the arc's real timestamps fall.
    const phaseOffsets = [0, CYCLE_LENGTH / 2];

    for (let j = 0; j < numParticles; j++) {
      if (logical >= maxParticles) break;
      const offsetWithinLife = (j / Math.max(1, numParticles - 1)) * effectiveDuration;
      for (const phase of phaseOffsets) {
        if (logical >= maxParticles) break;
        const tripStart = (start + offsetWithinLife + phase) % CYCLE_LENGTH;
        const stamps = (base: number) => path.map((_, idx) => base + (idx / (path.length - 1)) * tripSpan);
        trips.push({ path, timestamps: stamps(tripStart), color });
        // The particle (plus its fading trail) outlives the cycle: when the
        // clock wraps to 0 it would vanish mid-flight. Emit a twin shifted one
        // cycle back so it carries on across the wrap.
        if (tripStart + tripSpan + trail > CYCLE_LENGTH) {
          trips.push({ path, timestamps: stamps(tripStart - CYCLE_LENGTH), color });
        }
        logical++;
      }
    }
  }
  return trips;
}
