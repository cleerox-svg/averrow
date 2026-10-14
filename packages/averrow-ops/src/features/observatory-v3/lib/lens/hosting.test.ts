import { describe, it, expect } from 'vitest';
import type { ProviderGeo } from '@/hooks/useObservatoryLenses';
import { buildHostingModel, trendClass, ringRadiusPx, RING_MIN_PX, RING_MAX_PX, weeklyRunRate } from './hosting';
import { getCountryCentroid } from '@/lib/country-centroids';

const prov = (o: Partial<ProviderGeo> & { id: string }): ProviderGeo => ({
  name: o.id, asn: 'AS1', country: 'NL', active_threat_count: 10, total_threat_count: 100, trend_7d: 5, trend_30d: 20,
  is_bulletproof: false, reputation_score: null, takedown: null, ...o,
});

describe('trendClass', () => {
  it('compares this week to the 30-day weekly run-rate with a ±25% / 2-threat margin', () => {
    expect(weeklyRunRate(30)).toBeCloseTo(7);
    expect(trendClass(20, 30)).toBe('rising');
    expect(trendClass(1, 30)).toBe('falling');
    expect(trendClass(7, 30)).toBe('flat');
    expect(trendClass(2, 1)).toBe('flat'); // 1 -> 2 doesn't light up
    expect(trendClass(0, 0)).toBe('flat');
  });
});

describe('ringRadiusPx', () => {
  it('scales with the square root of active threats between min and max', () => {
    expect(ringRadiusPx(0, 100)).toBe(RING_MIN_PX);
    expect(ringRadiusPx(100, 100)).toBe(RING_MAX_PX);
    const mid = ringRadiusPx(25, 100);
    expect(mid).toBeCloseTo(RING_MIN_PX + (RING_MAX_PX - RING_MIN_PX) * 0.5);
    expect(ringRadiusPx(5, 0)).toBe(RING_MIN_PX);
  });
});

describe('buildHostingModel', () => {
  const m = buildHostingModel([
    prov({ id: 'big', active_threat_count: 400 }),
    prov({ id: 'small', active_threat_count: 40, trend_7d: 30, trend_30d: 30, is_bulletproof: true }),
    prov({ id: 'us', country: 'US', active_threat_count: 90, takedown: { share: 0.62, median_hours: 31, n: 141 } }),
    prov({ id: 'nowhere', country: null }),
    prov({ id: 'quiet', active_threat_count: 0 }),
    prov({ id: 'quiet-bp', active_threat_count: 0, is_bulletproof: true, country: 'RU' }),
  ]);
  it('places the biggest provider of a country on the centroid and spreads the rest', () => {
    const big = m.byId.get('big')!;
    const small = m.byId.get('small')!;
    expect(big.position).toEqual(getCountryCentroid('NL'));
    expect(small.position).not.toEqual(big.position);
  });
  it('drops unplaceable providers (counted) and silent non-bulletproof ones; keeps silent bulletproof ones', () => {
    expect(m.unplaced).toBe(1);
    expect(m.byId.has('quiet')).toBe(false);
    expect(m.byId.has('quiet-bp')).toBe(true);
  });
  it('carries trend class, bulletproof flag, takedown data and a size ∝ active threats', () => {
    expect(m.byId.get('small')!.trend).toBe('rising');
    expect(m.byId.get('small')!.bulletproof).toBe(true);
    expect(m.byId.get('us')!.takedownShare).toBeCloseTo(0.62);
    expect(m.byId.get('big')!.takedownShare).toBeNull();
    expect(m.byId.get('big')!.radiusPx).toBeGreaterThan(m.byId.get('small')!.radiusPx);
    expect(m.maxActive).toBe(400);
  });
});

describe('hosting spread stays over the country', () => {
  const prov = (i: number) => ({
    id: `p${i}`, name: `P${i}`, asn: null, country: 'NL', active_threat_count: 100 - i, total_threat_count: 1, trend_7d: 0, trend_30d: 0,
    is_bulletproof: false, reputation_score: null, takedown: null,
  });
  it('40 providers in one country never wander further than MAX_SPREAD_DEG from the centroid', async () => {
    const { buildHostingModel, MAX_SPREAD_DEG } = await import('./hosting');
    const { countryCenter } = await import('./placement');
    const m = buildHostingModel(Array.from({ length: 40 }, (_, i) => prov(i)));
    const c = countryCenter('NL')!;
    const lngScale = 1 / Math.max(Math.cos((c[1] * Math.PI) / 180), 0.35);
    for (const r of m.rings) {
      expect(Math.abs(r.position[1] - c[1])).toBeLessThanOrEqual(MAX_SPREAD_DEG + 1e-9);
      expect(Math.abs(r.position[0] - c[0])).toBeLessThanOrEqual(MAX_SPREAD_DEG * lngScale + 1e-9);
    }
    expect(new Set(m.rings.map(r => r.position.join(','))).size).toBe(40); // still distinct
  });
  it('a small group keeps the roomy spiral', async () => {
    const { buildHostingModel } = await import('./hosting');
    const { countryCenter } = await import('./placement');
    const m = buildHostingModel([prov(0), prov(1)]);
    const c = countryCenter('NL')!;
    expect(m.rings[0]!.position).toEqual(c);
    expect(Math.hypot(m.rings[1]!.position[0] - c[0], m.rings[1]!.position[1] - c[1])).toBeGreaterThan(2);
  });
});
