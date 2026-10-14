import { describe, it, expect } from 'vitest';
import type { TimelineData } from '@/hooks/useObservatoryLenses';
import {
  buildHistogram, fracToClock, clockToFrac, fracToTime, pointerFrac, bucketIndexAt, nudgePlayhead, stackedPaths,
  formatPlayheadTime, MAX_PLAYHEAD,
} from './timeline';
import { CYCLE_LENGTH } from '../trips';

const pt = (t: string, total: number, critical = 0, high = 0, medium = 0, low = 0) => ({ t, total, critical, high, medium, low });
const data: TimelineData = {
  bucket: '1h',
  points: [
    pt('2026-10-14T00:00:00Z', 10, 1, 2, 3, 4),
    pt('2026-10-14T01:00:00Z', 0),
    pt('2026-10-14T02:00:00Z', 20, 5, 5, 5, 3),
    pt('2026-10-14T03:00:00Z', 7, 0, 0, 0, 0),
  ],
};

describe('buildHistogram', () => {
  const h = buildHistogram(data)!;
  it('derives the span, max and total from the buckets', () => {
    expect(h.bars).toHaveLength(4);
    expect(h.startMs).toBe(Date.parse('2026-10-14T00:00:00Z'));
    expect(h.endMs).toBe(Date.parse('2026-10-14T04:00:00Z'));
    expect(h.max).toBe(20);
    expect(h.total).toBe(37);
  });
  it('sorts unsorted points and skips unparseable ones', () => {
    const messy = buildHistogram({ bucket: '6h', points: [pt('2026-10-14T06:00:00Z', 1), pt('nonsense', 9), pt('2026-10-14T00:00:00Z', 2)] })!;
    expect(messy.bars.map(b => b.total)).toEqual([2, 1]);
    expect(messy.bucketMs).toBe(21_600_000);
  });
  it('returns null when there is nothing to draw', () => {
    expect(buildHistogram(undefined)).toBeNull();
    expect(buildHistogram({ bucket: '1h', points: [] })).toBeNull();
  });
});

describe('seek mapping', () => {
  const h = buildHistogram(data)!;
  it('fraction <-> clock <-> time are linear and consistent', () => {
    expect(fracToClock(0)).toBe(0);
    expect(fracToClock(0.5)).toBe(CYCLE_LENGTH / 2);
    expect(clockToFrac(CYCLE_LENGTH / 4)).toBe(0.25);
    expect(fracToTime(0.5, h)).toBe(Date.parse('2026-10-14T02:00:00Z'));
    expect(fracToTime(1, h)).toBe(h.endMs);
  });
  it('never lets a scrub to the far right wrap to 0', () => {
    expect(fracToClock(1)).toBeLessThan(CYCLE_LENGTH);
    expect(fracToClock(1)).toBe(MAX_PLAYHEAD);
    expect(fracToClock(5)).toBe(MAX_PLAYHEAD);
    expect(fracToClock(-1)).toBe(0);
    expect(fracToClock(NaN)).toBe(0);
  });
  it('maps pointer x to a clamped fraction', () => {
    expect(pointerFrac(150, 100, 200)).toBe(0.25);
    expect(pointerFrac(50, 100, 200)).toBe(0);
    expect(pointerFrac(999, 100, 200)).toBe(1);
    expect(pointerFrac(10, 0, 0)).toBe(0);
  });
  it('finds the bucket under a fraction', () => {
    expect(bucketIndexAt(0, 4)).toBe(0);
    expect(bucketIndexAt(0.26, 4)).toBe(1);
    expect(bucketIndexAt(1, 4)).toBe(3);
  });
  it('keyboard nudges move one bucket (or coarse) and stay inside the bar', () => {
    const one = CYCLE_LENGTH / 4;
    expect(nudgePlayhead(0, 1, 4)).toBe(one);
    expect(nudgePlayhead(one, -1, 4)).toBe(0);
    expect(nudgePlayhead(0, -1, 4)).toBe(0);
    expect(nudgePlayhead(CYCLE_LENGTH - 1, 1, 4)).toBe(MAX_PLAYHEAD);
    expect(nudgePlayhead(0, 1, 100, 10)).toBeCloseTo(CYCLE_LENGTH / 10);
  });
});

describe('stackedPaths', () => {
  const h = buildHistogram(data)!;
  it('emits one rect per non-zero severity segment, in the right channel', () => {
    const p = stackedPaths(h, 400, 40);
    expect(p.critical.match(/M/g)).toHaveLength(2); // buckets 0 and 2
    expect(p.low.match(/M/g)).toHaveLength(2);
    expect(p.other.match(/M/g)).toHaveLength(2); // bucket 2 (20 total, 18 known) and bucket 3 (7, none known)
    expect(p.critical).not.toContain('NaN');
  });
  it('the tallest bar fills the height', () => {
    const p = stackedPaths(h, 400, 40);
    // bucket 2 (total 20 = max): its topmost segment ('other') ends at the top edge, y = 1
    expect(p.other).toMatch(/M200\.25 1h/);
  });
  it('is empty for an empty histogram or zero size', () => {
    expect(stackedPaths({ ...h, max: 0 }, 400, 40).critical).toBe('');
    expect(stackedPaths(h, 0, 40).critical).toBe('');
  });
});

describe('formatPlayheadTime', () => {
  it('shows date + UTC time for hourly buckets and just the date for daily', () => {
    const ms = Date.parse('2026-10-14T13:00:00Z');
    expect(formatPlayheadTime(ms, 3_600_000)).toBe('14 Oct 13:00 UTC');
    expect(formatPlayheadTime(ms, 86_400_000)).toBe('14 Oct');
  });
});
