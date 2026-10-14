import { describe, it, expect } from 'vitest';
import type { ArcData } from '@/hooks/useObservatory';
import { arcPathFor, buildTripData, getArcPath, getGlobeArcPath, periodToMs, GLOBE_ARC_LIFT, TRIP_SPAN } from './trips';
import { EARTH_RADIUS_M, greatCircleAngle } from '../anim/great-circle';

const arc = (over: Partial<ArcData> = {}): ArcData => ({
  sourcePosition: [10, 20], targetPosition: [-100, 40], threat_type: 'phishing', severity: 'high',
  source_region: 'X', target_brand: 'b', brand_name: 'Brand', volume: 20, ...over,
});

const D2R = Math.PI / 180;
/** Unit vector for a lng/lat. */
const vec = (lng: number, lat: number): [number, number, number] => [
  Math.cos(lat * D2R) * Math.cos(lng * D2R), Math.cos(lat * D2R) * Math.sin(lng * D2R), Math.sin(lat * D2R),
];

describe('getGlobeArcPath: true great circles, lifted off the surface', () => {
  it('memoises on the arc object, separately from the flat path', () => {
    const a = arc();
    expect(getGlobeArcPath(a)).toBe(getGlobeArcPath(a));
    expect(getGlobeArcPath(a)).not.toBe(getArcPath(a));
    expect(getGlobeArcPath(arc())).not.toBe(getGlobeArcPath(a));
  });

  it('starts and ends ON the surface at the two points (altitude 0), 3D throughout', () => {
    const p = getGlobeArcPath(arc());
    expect(p[0]).toEqual([10, 20, 0]);
    const end = p[p.length - 1]!;
    expect(end[0]).toBeCloseTo(-100, 6);
    expect(end[1]).toBeCloseTo(40, 6);
    expect(end[2]).toBeCloseTo(0, 6);
    expect(p.every(pt => pt.length === 3)).toBe(true);
  });

  it('every point lies on the plane of the great circle (so it is the shortest route, not a Mercator curve)', () => {
    const a = arc({ sourcePosition: [10, 20], targetPosition: [-100, 40] });
    const A = vec(10, 20), B = vec(-100, 40);
    const n = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
    const nl = Math.hypot(n[0]!, n[1]!, n[2]!);
    for (const pt of getGlobeArcPath(a)) {
      const v = vec(pt[0], pt[1]);
      expect(Math.abs((v[0] * n[0]! + v[1] * n[1]! + v[2] * n[2]!) / nl)).toBeLessThan(1e-9);
    }
  });

  it('the flat bezier is NOT a great circle (the reason the globe has its own path)', () => {
    const a = arc();
    const A = vec(10, 20), B = vec(-100, 40);
    const n = [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
    const nl = Math.hypot(n[0]!, n[1]!, n[2]!);
    const mid = getArcPath(a)[15]!;
    const v = vec(mid[0], mid[1]);
    expect(Math.abs((v[0] * n[0]! + v[1] * n[1]! + v[2] * n[2]!) / nl)).toBeGreaterThan(1e-3); // a great circle sits at ~1e-16
  });

  it('rises to a mid-span peak that grows with the span and never exceeds the lift cap', () => {
    const peak = (a: ArcData) => Math.max(...getGlobeArcPath(a).map(p => p[2]!));
    const short = peak(arc({ sourcePosition: [0, 0], targetPosition: [10, 0] }));
    const long = peak(arc({ sourcePosition: [0, 0], targetPosition: [170, 0] }));
    expect(long).toBeGreaterThan(short * 5);
    expect(long).toBeLessThanOrEqual(EARTH_RADIUS_M * GLOBE_ARC_LIFT + 1e-6);
    const p = getGlobeArcPath(arc({ sourcePosition: [0, 0], targetPosition: [170, 0] }));
    expect(p[Math.floor(p.length / 2)]![2]).toBeCloseTo(long, 0);
  });

  it('is dense enough that segments hug the sphere (sag between points is negligible)', () => {
    const a = arc({ sourcePosition: [0, 0], targetPosition: [170, 0] });
    const p = getGlobeArcPath(a);
    const total = greatCircleAngle(a.sourcePosition, a.targetPosition);
    const step = total / (p.length - 1);
    expect(step).toBeLessThan(0.1); // radians: ~6 degrees per segment
  });

  it('crosses the antimeridian as one continuous path (no jump across the map)', () => {
    const p = getGlobeArcPath(arc({ sourcePosition: [170, 10], targetPosition: [-170, 20] }));
    for (let i = 1; i < p.length; i++) expect(Math.abs(p[i]![0] - p[i - 1]![0])).toBeLessThan(180);
  });
});

describe('arcPathFor picks the path the projection draws', () => {
  it('flat -> bezier, globe -> lifted great circle', () => {
    const a = arc();
    expect(arcPathFor(a, 'flat')).toBe(getArcPath(a));
    expect(arcPathFor(a, 'globe')).toBe(getGlobeArcPath(a));
  });
});

describe('buildTripData per projection', () => {
  const now = Date.UTC(2026, 9, 1);
  const arcs = [arc(), arc({ threat_type: 'c2', sourcePosition: [5, 5] })];

  it('defaults to the flat bezier (unchanged behaviour)', () => {
    const t = buildTripData(arcs, 'severity', false, periodToMs('7d'), now);
    expect(t[0]!.path).toBe(getArcPath(arcs[0]!));
    expect(buildTripData(arcs, 'severity', false, periodToMs('7d'), now, 'flat')).toEqual(t);
  });

  it('on the globe particles ride the lifted great circle, with one timestamp per path point', () => {
    const t = buildTripData(arcs, 'severity', false, periodToMs('7d'), now, 'globe');
    expect(t.length).toBeGreaterThan(0);
    expect(t[0]!.path).toBe(getGlobeArcPath(arcs[0]!));
    for (const trip of t) {
      expect(trip.timestamps).toHaveLength(trip.path.length);
      // the same traversal time as on the flat map: a particle takes about TRIP_SPAN (scaled by severity speed) to land
      const span = trip.timestamps.at(-1)! - trip.timestamps[0]!;
      expect(span).toBeGreaterThan(TRIP_SPAN * 0.8);
      expect(span).toBeLessThanOrEqual(TRIP_SPAN * 1.2 + 1e-9);
    }
  });

  it('the particle count does not depend on the projection', () => {
    expect(buildTripData(arcs, 'severity', false, periodToMs('7d'), now, 'globe').length)
      .toBe(buildTripData(arcs, 'severity', false, periodToMs('7d'), now, 'flat').length);
  });
});
