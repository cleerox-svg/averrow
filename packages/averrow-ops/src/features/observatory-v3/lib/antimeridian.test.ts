import { describe, it, expect } from 'vitest';
import {
  unwrapRing, splitRingAtAntimeridian, splitGeometryAtAntimeridian, maxLongitudeJump, ringArea, type Ring,
} from './antimeridian';

// A box straddling the date line: 170E to 170W (20 degrees wide), written the way Natural Earth does (jumps).
const straddle: Ring = [[170, 0], [180, 0], [-180, 0], [-170, 0], [-170, 10], [-180, 10], [180, 10], [170, 10], [170, 0]];

describe('antimeridian splitting', () => {
  it('unwrap makes longitudes continuous', () => {
    const u = unwrapRing(straddle);
    for (let i = 1; i < u.length; i++) expect(Math.abs(u[i]![0] - u[i - 1]![0])).toBeLessThanOrEqual(180);
    expect(Math.max(...u.map(p => p[0]))).toBe(190);
  });

  it('leaves a ring with no jump untouched (same object)', () => {
    const ring: Ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const out = splitRingAtAntimeridian(ring);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ring);
  });

  it('cuts a straddling ring into an east and a west piece, each inside [-180, 180], total area kept', () => {
    const pieces = splitRingAtAntimeridian(straddle);
    expect(pieces).toHaveLength(2);
    for (const p of pieces) {
      expect(maxLongitudeJump({ type: 'Polygon', coordinates: [p] })).toBeLessThanOrEqual(180);
      for (const [x] of p) { expect(x).toBeGreaterThanOrEqual(-180); expect(x).toBeLessThanOrEqual(180); }
      expect(p[0]).toEqual(p[p.length - 1]);
    }
    const area = pieces.reduce((a, p) => a + ringArea(p), 0);
    expect(area).toBeCloseTo(20 * 10, 5);
    const xs = pieces.map(p => [Math.min(...p.map(q => q[0])), Math.max(...p.map(q => q[0]))]).sort((a, b) => a[0]! - b[0]!);
    expect(xs).toEqual([[-180, -170], [170, 180]]);
  });

  it('splits a geometry into a MultiPolygon', () => {
    const g = splitGeometryAtAntimeridian({ type: 'Polygon', coordinates: [straddle] });
    expect(g.type).toBe('MultiPolygon');
    expect(maxLongitudeJump(g as never)).toBeLessThanOrEqual(180);
  });
});
