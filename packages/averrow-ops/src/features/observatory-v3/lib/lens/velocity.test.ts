import { describe, it, expect } from 'vitest';
import type { VelocityNode } from '@/hooks/useObservatoryLenses';
import { buildVelocityModel, velocityRadiusPx, VELOCITY_MIN_PX, VELOCITY_MAX_PX, VELOCITY_COLOR, VELOCITY_FILLING } from './velocity';
import { SEVERITY_COLORS, THREAT_TYPE_COLORS } from '../map-colors';

const node = (cc: string, veryFast: number, fast: number, over: Partial<VelocityNode> = {}): VelocityNode => ({
  lat: 10, lng: 20, threat_count: veryFast + fast, country_code: cc, very_fast: veryFast, fast, precision: 'country', ...over,
});

describe('buildVelocityModel', () => {
  const m = buildVelocityModel([node('de', 1, 2), node('NL', 8, 4), node('US', 0, 6)], 3);
  it('orders by very_fast + fast (ties by country) and totals the classes', () => {
    expect(m.points.map(p => p.cc)).toEqual(['NL', 'US', 'DE']);
    expect(m.veryFast).toBe(9);
    expect(m.fast).toBe(12);
    expect(m.total).toBe(21);
    expect(m.max).toBe(12);
    expect(m.dropped).toBe(3);
  });
  it('size is √-scaled between the min and max radius; the biggest node is the max', () => {
    expect(m.points[0]!.radiusPx).toBe(VELOCITY_MAX_PX);
    expect(m.points[2]!.radiusPx).toBeGreaterThan(VELOCITY_MIN_PX);
    expect(m.points[2]!.radiusPx).toBeLessThan(m.points[1]!.radiusPx + 1e-9);
    expect(velocityRadiusPx(0, 10)).toBe(VELOCITY_MIN_PX);
    expect(velocityRadiusPx(5, 0)).toBe(VELOCITY_MIN_PX);
    expect(velocityRadiusPx(25, 100)).toBeCloseTo(VELOCITY_MIN_PX + (VELOCITY_MAX_PX - VELOCITY_MIN_PX) * 0.5, 9);
  });
  it('only nodes with a very-fast count are "hot" (pulse)', () => {
    expect(m.byCc.get('NL')!.hot).toBe(true);
    expect(m.byCc.get('US')!.hot).toBe(false);
  });
  it('places nodes at the server-supplied centroid as [lng, lat]', () => {
    expect(m.points[0]!.position).toEqual([20, 10]);
  });
  it('drops junk: no country, no counts, non-finite coordinates', () => {
    const bad = buildVelocityModel([node('XX1', 1, 1), node('NL', 0, 0), node('DE', 1, 1, { lat: Number.NaN }), node('FR', 2, 0)]);
    expect(bad.points.map(p => p.cc)).toEqual(['FR']);
  });
  it('an empty answer is a model with no points (callers say "coverage still filling")', () => {
    const e = buildVelocityModel([]);
    expect(e.points).toEqual([]);
    expect(e.total).toBe(0);
    expect(VELOCITY_FILLING).toMatch(/still filling/i);
    expect(VELOCITY_FILLING).not.toMatch(/\bnone\b/i);
  });
  it('the phase is stable per country (a synchronised heartbeat across refetches)', () => {
    expect(buildVelocityModel([node('NL', 1, 0)]).points[0]!.phase).toBe(buildVelocityModel([node('NL', 9, 9)]).points[0]!.phase);
  });
});

describe('the velocity colour is its own', () => {
  const hue = ([r, g, b]: ReadonlyArray<number>): number => {
    const mx = Math.max(r!, g!, b!), mn = Math.min(r!, g!, b!), d = mx - mn;
    if (d === 0) return 0;
    const h = mx === r ? ((g! - b!) / d) % 6 : mx === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const apart = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const chromatic = (c: ReadonlyArray<number>): boolean => Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!) > 60;
  it('is not any severity or threat-type colour, and not a near-neighbour in hue', () => {
    for (const c of [...Object.values(SEVERITY_COLORS), ...Object.values(THREAT_TYPE_COLORS)]) {
      expect(VELOCITY_COLOR.slice(0, 3)).not.toEqual(c.slice(0, 3));
      if (chromatic(c)) expect(apart(hue(VELOCITY_COLOR), hue(c)), `vs ${c}`).toBeGreaterThanOrEqual(12);
    }
  });
});
