// Threat tempo: the current hourly ingest rate against a 7-day baseline.
//
// Input is the same `/api/threats/inflow` payload ThreatInflowChart reads
// (hourly buckets, oldest first, stacked by threat_type). The worker anchors
// the rightmost bucket to the CURRENT hour, so it is only partially filled and
// would read as a false "quiet" early in the hour. Both numbers therefore use
// completed buckets only:
//
//   currentRate  = total of the last completed hourly bucket (24h window)
//   baselineRate = mean total per ACTIVE (non-zero) completed hourly bucket over
//                  the 7d window; null with fewer than MIN_BASELINE_BUCKETS of them
//   ratio        = currentRate / baselineRate
//
// The worker zero-pads the 7d window to 168 buckets, so a bucket count says
// nothing about how much data exists. Zero buckets (a young deployment, or a
// multi-day data gap) are therefore left out of the mean, otherwise they drag
// the baseline down and make a normal hour read as a surge.
//
// The chip state is deliberately two-sided: ≥1.5× is a surge, <0.5× is
// "quiet". A silent ingest pipeline must read as quiet, not as calm.

import type { InflowResponse } from '@/features/threats/useThreatInflow';

export const SURGE_RATIO = 1.5;
export const QUIET_RATIO = 0.5;
/** Fewer ACTIVE (non-zero) 7d buckets than this and the baseline is not trustworthy. */
export const MIN_BASELINE_BUCKETS = 24;

export type TempoState = 'surge' | 'normal' | 'quiet' | 'unknown';

export interface Tempo {
  /** Threats ingested in the last completed hour. */
  currentRate: number;
  /** Mean threats per hour over the 7d window; null when unavailable. */
  baselineRate: number | null;
  /** currentRate / baselineRate; null when there is no usable baseline. */
  ratio: number | null;
  state: TempoState;
  /** Completed hourly totals over the 24h window, oldest first. */
  sparkline: number[];
}

/** Sum every series' count per bucket (missing/NaN counts are 0). */
export function bucketTotals(r: Pick<InflowResponse, 'buckets' | 'series'>): number[] {
  const out = new Array<number>(r.buckets.length).fill(0);
  for (const s of r.series) {
    if (!Array.isArray(s.counts)) continue;
    for (let i = 0; i < out.length; i++) {
      const n = s.counts[i];
      if (typeof n === 'number' && Number.isFinite(n)) out[i] = (out[i] ?? 0) + n;
    }
  }
  return out;
}

export function tempoState(
  ratio: number | null,
  currentRate: number,
  _baselineRate: number | null,
  weekHadIngest = true,
): TempoState {
  if (ratio === null) {
    // No ingest all week and none now is genuinely silent, not unknown.
    return !weekHadIngest && currentRate === 0 ? 'quiet' : 'unknown';
  }
  if (ratio >= SURGE_RATIO) return 'surge';
  if (ratio < QUIET_RATIO) return 'quiet';
  return 'normal';
}

/** Returns null when the 24h window has no completed bucket to read. */
export function computeTempo(
  h24: Pick<InflowResponse, 'buckets' | 'series'>,
  d7: Pick<InflowResponse, 'buckets' | 'series'>,
): Tempo | null {
  const day = bucketTotals(h24).slice(0, -1); // drop the in-progress hour
  const last = day[day.length - 1];
  if (last === undefined) return null;
  const currentRate = last;

  const week = bucketTotals(d7).slice(0, -1);
  const active = week.filter((n) => n > 0);
  const baselineRate = active.length >= MIN_BASELINE_BUCKETS
    ? active.reduce((s, n) => s + n, 0) / active.length
    : null;
  const ratio = baselineRate !== null && baselineRate > 0 ? currentRate / baselineRate : null;

  return {
    currentRate,
    baselineRate,
    ratio,
    state: tempoState(ratio, currentRate, baselineRate, active.length > 0),
    sparkline: day,
  };
}
