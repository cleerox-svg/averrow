import { describe, it, expect } from 'vitest';
import { ArrivalScheduler, buildArrivalEvents, type ArrivalEvent } from './arrivals';
import { buildTripData, CYCLE_LENGTH, TRIP_SPAN, type TripDatum } from '../lib/trips';
import type { ArcData } from '@/hooks/useObservatory';

const C = 3600;
const ev = (time: number, key = String(time)): ArrivalEvent => ({ time, lng: 0, lat: 0, color: [1, 2, 3, 4], key });

describe('ArrivalScheduler.collect', () => {
  const events = [ev(10), ev(20), ev(20.5, 'b'), ev(3590), ev(3599.5), ev(0)].sort((a, b) => a.time - b.time);
  const s = new ArrivalScheduler(events, C, 60);

  it('returns events in (prev, t]', () => {
    expect(s.collect(9, 10).map(e => e.time)).toEqual([10]); // inclusive upper bound
    expect(s.collect(10, 20).map(e => e.time)).toEqual([20]); // exclusive lower bound
    expect(s.collect(9, 21).map(e => e.time)).toEqual([10, 20, 20.5]);
  });

  it('returns nothing when no event is crossed', () => {
    expect(s.collect(11, 19)).toEqual([]);
  });

  it('is wrap-aware: crossing the loop point yields events on both sides', () => {
    expect(s.collect(3599, 2).map(e => e.time)).toEqual([3599.5, 0]);
  });

  it('does not double-count across consecutive frames', () => {
    const seen: number[] = [];
    let prev = 3585;
    for (let i = 0; i < 40; i++) {
      const t = (prev + 0.5) % C;
      seen.push(...s.collect(prev, t).map(e => e.time));
      prev = t;
    }
    expect(seen).toEqual([3590, 3599.5, 0]);
  });

  it('emits nothing for backwards playback, seeks, or no movement', () => {
    expect(s.collect(21, 9)).toEqual([]);
    expect(s.collect(10, 10)).toEqual([]);
    expect(s.collect(0, 1800)).toEqual([]); // seek
    expect(s.collect(10, 100)).toEqual([]); // jump > maxStep
  });

  it('appends to a caller-provided scratch array (no allocation)', () => {
    const out: ArrivalEvent[] = [];
    const r = s.collect(9, 10, out);
    expect(r).toBe(out);
    expect(out).toHaveLength(1);
  });

  it('works with no events', () => {
    expect(new ArrivalScheduler([], C).collect(0, 5)).toEqual([]);
  });
});

describe('buildArrivalEvents', () => {
  const path: [number, number][] = [[0, 0], [5, 5], [10, 10]];
  const trip = (start: number, color: [number, number, number, number] = [9, 9, 9, 220]): TripDatum => ({
    path, timestamps: [start, start + TRIP_SPAN / 2, start + TRIP_SPAN], color, severity: 'high',
  });

  it('uses the last timestamp mod the cycle, at the path end, sorted', () => {
    const events = buildArrivalEvents([trip(500), trip(100)], C);
    expect(events.map(e => e.time)).toEqual([100 + TRIP_SPAN, 500 + TRIP_SPAN]);
    expect(events[0]).toMatchObject({ lng: 10, lat: 10, color: [9, 9, 9, 220] });
  });

  it('wraps arrivals that land after the loop point', () => {
    const [e] = buildArrivalEvents([trip(C - 50)], C);
    expect(e!.time).toBeCloseTo(TRIP_SPAN - 50, 8);
  });

  it('skips wrap twins (negative-start duplicates)', () => {
    const real = trip(C - 50);
    const twin: TripDatum = { ...real, timestamps: real.timestamps.map(t => t - C) };
    expect(buildArrivalEvents([real, twin], C)).toHaveLength(1);
  });

  it('shares a key for the same target (for throttling)', () => {
    const [a, b] = buildArrivalEvents([trip(100), trip(900)], C);
    expect(a!.key).toBe(b!.key);
  });

  it('produces exactly one event per real trip from buildTripData', () => {
    const arcs: ArcData[] = [
      { sourcePosition: [10, 50], targetPosition: [-74, 40], threat_type: 'phishing', severity: 'critical', source_region: 'EU', target_brand: 'b', brand_name: 'B', volume: 30 },
      { sourcePosition: [100, 30], targetPosition: [-0.1, 51], threat_type: 'malware', severity: 'low', source_region: 'AS', target_brand: 'c', brand_name: 'C', volume: 5 },
    ];
    const trips = buildTripData(arcs, 'severity', false, 7 * 24 * 3600_000, Date.UTC(2026, 0, 8));
    const real = trips.filter(t => t.timestamps[0]! >= 0).length;
    const events = buildArrivalEvents(trips, CYCLE_LENGTH);
    expect(events).toHaveLength(real);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.time).toBeGreaterThanOrEqual(0);
      expect(e.time).toBeLessThan(CYCLE_LENGTH);
    }
  });
});
