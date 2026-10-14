import { describe, it, expect } from 'vitest';
import type { ArcData } from '@/hooks/useObservatory';
import {
  buildTripData, computeLifeWindow, getArcPath, CYCLE_LENGTH, TRIP_SPAN, trailLengthFor, MOBILE_MAX_PARTICLES, periodToMs,
} from './trips';

const arc = (over: Partial<ArcData> = {}): ArcData => ({
  sourcePosition: [10, 20], targetPosition: [-100, 40], threat_type: 'phishing', severity: 'high',
  source_region: 'X', target_brand: 'b', brand_name: 'Brand', volume: 20, ...over,
});

describe('getArcPath', () => {
  it('memoises on the arc object', () => {
    const a = arc();
    expect(getArcPath(a)).toBe(getArcPath(a));
    expect(getArcPath(arc())).not.toBe(getArcPath(a));
  });
  it('runs from source to target', () => {
    const p = getArcPath(arc());
    expect(p[0]).toEqual([10, 20]);
    expect(p[p.length - 1][0]).toBeCloseTo(-100);
    expect(p[p.length - 1][1]).toBeCloseTo(40);
  });
});

describe('buildTripData', () => {
  const now = Date.UTC(2026, 9, 1);

  it('is deterministic for the same input and clock', () => {
    const arcs = [arc(), arc({ threat_type: 'c2', sourcePosition: [5, 5] })];
    expect(buildTripData(arcs, 'severity', false, periodToMs('7d'), now))
      .toEqual(buildTripData(arcs, 'severity', false, periodToMs('7d'), now));
  });

  it('never leaves a particle clipped at the loop wrap: anything outliving the cycle has a twin shifted back one cycle', () => {
    const arcs = Array.from({ length: 40 }, (_, i) => arc({ sourcePosition: [i * 3, i], volume: 30 }));
    const trips = buildTripData(arcs, 'severity', false, periodToMs('7d'), now);
    const trail = trailLengthFor(false);
    let spanning = 0;
    for (const t of trips) {
      const first = t.timestamps[0];
      const last = t.timestamps[t.timestamps.length - 1];
      if (first >= 0 && last + trail > CYCLE_LENGTH) {
        spanning++;
        const twin = trips.find(o => o.path === t.path && Math.abs(o.timestamps[0] - (first - CYCLE_LENGTH)) < 1e-6);
        expect(twin).toBeDefined();
      }
    }
    expect(spanning).toBeGreaterThan(0); // the fixture actually exercises the wrap
  });

  it('timestamps are monotonic per trip and span ~TRIP_SPAN', () => {
    const [t] = buildTripData([arc({ severity: 'medium' })], 'severity', false, periodToMs('24h'), now);
    for (let i = 1; i < t.timestamps.length; i++) expect(t.timestamps[i]).toBeGreaterThan(t.timestamps[i - 1]);
    expect(t.timestamps[t.timestamps.length - 1] - t.timestamps[0]).toBeCloseTo(TRIP_SPAN, 5);
  });

  it('caps logical particles on mobile', () => {
    const arcs = Array.from({ length: 500 }, (_, i) => arc({ sourcePosition: [i % 180, i % 80], volume: 50 }));
    const trips = buildTripData(arcs, 'type', true, periodToMs('7d'), now);
    // twins add at most a bounded extra
    expect(trips.length).toBeLessThanOrEqual(MOBILE_MAX_PARTICLES * 2);
    expect(trips.length).toBeGreaterThanOrEqual(MOBILE_MAX_PARTICLES);
  });

  it('survives garbage timestamps', () => {
    expect(() => buildTripData([arc({ first_seen: 'nope', last_seen: 'nah' })], 'severity', false, 1000, now)).not.toThrow();
  });
});

describe('computeLifeWindow timestamps (D1 UTC strings)', () => {
  const windowEnd = Date.UTC(2026, 9, 14, 12, 0, 0);
  const windowStart = windowEnd - periodToMs('24h');

  it('parses zone-less "YYYY-MM-DD HH:MM:SS" as UTC regardless of the local timezone', () => {
    const bare = arc({ first_seen: '2026-10-14 02:00:00', last_seen: '2026-10-14 04:00:00' });
    const zoned = arc({ first_seen: '2026-10-14T02:00:00Z', last_seen: '2026-10-14T04:00:00Z' });
    const prevTz = process.env.TZ;
    try {
      for (const tz of ['America/Toronto', 'Asia/Tokyo', 'UTC']) {
        process.env.TZ = tz;
        expect(computeLifeWindow(bare, windowStart, windowEnd)).toEqual(computeLifeWindow(zoned, windowStart, windowEnd));
      }
    } finally {
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    }
  });
});
