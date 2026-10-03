import { describe, it, expect } from 'vitest';
import {
  MIN_BASELINE_BUCKETS,
  QUIET_RATIO,
  SURGE_RATIO,
  bucketTotals,
  computeTempo,
  tempoState,
} from './threat-tempo';

// Build an inflow-shaped payload from per-bucket totals (split across two
// threat types so the per-bucket sum is exercised).
function inflow(totals: number[]) {
  return {
    buckets: totals.map((_, i) => `2026-10-03 ${String(i % 24).padStart(2, '0')}:00:00`),
    series: [
      { threat_type: 'phishing', counts: totals.map((n) => Math.ceil(n / 2)), total: 0 },
      { threat_type: 'malicious_ip', counts: totals.map((n) => Math.floor(n / 2)), total: 0 },
    ],
  };
}

/** 24h window: `completed` hourly totals plus the partial in-progress bucket. */
const day = (completed: number[], partial = 0) => inflow([...completed, partial]);
/** 7d window of `hours` completed buckets, all equal to `level`, plus a partial bucket. */
const week = (level: number, hours = 167, partial = 0) => inflow([...new Array<number>(hours).fill(level), partial]);

describe('bucketTotals', () => {
  it('sums every series per bucket', () => {
    expect(bucketTotals(inflow([5, 8, 0]))).toEqual([5, 8, 0]);
  });
  it('treats missing, short and non-finite counts as 0', () => {
    expect(bucketTotals({
      buckets: ['a', 'b', 'c'],
      series: [{ threat_type: 'x', counts: [1, Number.NaN], total: 0 }],
    })).toEqual([1, 0, 0]);
  });
});

describe('computeTempo', () => {
  it('current rate is the last COMPLETED hour, ignoring the in-progress bucket', () => {
    const t = computeTempo(day([100, 120, 300], 7), week(100));
    expect(t?.currentRate).toBe(300);
  });

  it('baseline is the mean of completed 7d buckets, ignoring the partial one', () => {
    const t = computeTempo(day([100]), week(100, 167, 9999));
    expect(t?.baselineRate).toBe(100);
  });

  it('ratio = current / baseline', () => {
    const t = computeTempo(day([180]), week(100));
    expect(t?.ratio).toBeCloseTo(1.8, 5);
    expect(t?.state).toBe('surge');
  });

  it('exposes the completed 24h series for the sparkline (no partial bucket)', () => {
    const t = computeTempo(day([1, 2, 3], 99), week(10));
    expect(t?.sparkline).toEqual([1, 2, 3]);
  });

  it('returns null when the 24h window has no completed bucket', () => {
    expect(computeTempo(inflow([5]), week(10))).toBeNull();
    expect(computeTempo(inflow([]), week(10))).toBeNull();
  });

  it('has no baseline (state unknown) below the minimum bucket count', () => {
    const t = computeTempo(day([50]), week(100, MIN_BASELINE_BUCKETS - 1));
    expect(t?.baselineRate).toBeNull();
    expect(t?.ratio).toBeNull();
    expect(t?.state).toBe('unknown');
  });

  it('reads silent ingest as quiet, not unknown, when the baseline is also zero', () => {
    const t = computeTempo(day([0]), week(0));
    expect(t?.ratio).toBeNull();
    expect(t?.state).toBe('quiet');
  });

  it('a zero baseline with live ingest is unknown (ratio is undefined)', () => {
    const t = computeTempo(day([40]), week(0));
    expect(t?.state).toBe('unknown');
  });
});

describe('baseline ignores worker zero-padding and data gaps', () => {
  it('a mostly-zero week (young deployment) has no baseline, so a normal hour is not a surge', () => {
    const w = [...new Array<number>(150).fill(0), ...new Array<number>(17).fill(100)];
    const t = computeTempo(day([100]), inflow([...w, 0]));
    expect(t?.baselineRate).toBeNull();
    expect(t?.ratio).toBeNull();
    expect(t?.state).toBe('unknown');
  });

  it('a 3-day gap does not drag the baseline down', () => {
    // 4 days of steady 100/hr, 3 days of nothing.
    const w = [...new Array<number>(96).fill(100), ...new Array<number>(71).fill(0)];
    const t = computeTempo(day([110]), inflow([...w, 0]));
    expect(t?.baselineRate).toBe(100);
    expect(t?.ratio).toBeCloseTo(1.1, 5);
    expect(t?.state).toBe('normal');
  });

  it('a gap in the middle of the week is ignored too', () => {
    const w = [...new Array<number>(48).fill(100), ...new Array<number>(72).fill(0), ...new Array<number>(47).fill(100)];
    const t = computeTempo(day([100]), inflow([...w, 0]));
    expect(t?.baselineRate).toBe(100);
    expect(t?.state).toBe('normal');
  });

  it('a mostly-zero week with a quiet current hour is unknown, not silent', () => {
    const w = [...new Array<number>(160).fill(0), ...new Array<number>(7).fill(50)];
    expect(computeTempo(day([0]), inflow([...w, 0]))?.state).toBe('unknown');
  });
});

describe('tempoState thresholds', () => {
  it('surge at exactly 1.5x and above', () => {
    expect(tempoState(SURGE_RATIO, 150, 100)).toBe('surge');
    expect(tempoState(SURGE_RATIO - 0.01, 149, 100)).toBe('normal');
  });
  it('quiet strictly below 0.5x', () => {
    expect(tempoState(QUIET_RATIO - 0.01, 49, 100)).toBe('quiet');
    expect(tempoState(QUIET_RATIO, 50, 100)).toBe('normal');
  });
  it('is normal in between', () => {
    expect(tempoState(1, 100, 100)).toBe('normal');
  });
});
