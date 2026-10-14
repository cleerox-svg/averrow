import { describe, it, expect } from 'vitest';
import type { ThreatPoint } from '@/hooks/useObservatory';
import { topOrigins } from './origins';

const n = (o: Partial<ThreatPoint>): ThreatPoint => ({
  lat: 10, lng: 10, threat_count: 1, top_severity: 'low', critical: 0, high: 0, medium: 0, low: 1, country_code: 'GB', top_threat_type: null, ...o,
});

describe('topOrigins', () => {
  it('sums every node but picks the busiest PLACEABLE node', () => {
    const bad = n({ lat: NaN, threat_count: 500, country_code: 'GB' });
    const a = n({ threat_count: 40, country_code: 'GB' });
    const b = n({ threat_count: 60, country_code: 'GB', lat: 51, lng: 0 });
    const [gb] = topOrigins([bad, a, b]);
    expect(gb.count).toBe(600);
    expect(gb.node).toBe(b);
  });
  it('yields a null node when no node of the country can be placed', () => {
    const [row] = topOrigins([n({ lat: 0, lng: 0, country_code: 'XX', threat_count: 3 })]);
    expect(row.node).toBeNull();
    expect(row.count).toBe(3);
  });
  it('a placeable node found after an unplaceable first one still wins', () => {
    const first = n({ lat: Infinity, country_code: 'US', threat_count: 9 });
    const second = n({ country_code: 'US', threat_count: 1 });
    expect(topOrigins([first, second])[0].node).toBe(second);
  });
  it('sorts by volume, caps at the limit and skips country-less nodes', () => {
    const rows = topOrigins([n({ country_code: 'A1', threat_count: 1 }), n({ country_code: 'B1', threat_count: 5 }), n({ country_code: null, threat_count: 99 })], 1);
    expect(rows.map(r => r.code)).toEqual(['B1']);
  });
});
