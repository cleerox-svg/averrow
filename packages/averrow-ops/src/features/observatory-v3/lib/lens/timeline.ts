/**
 * Replay timeline model: bucketing the /timeline series into a histogram and
 * mapping a pointer / key / clock position <-> time <-> AnimationClock playhead.
 *
 * The clock loops over CYCLE_LENGTH units that represent the whole selected
 * period (the same mapping the particles use), so a fraction f of the bar is
 * f * CYCLE_LENGTH on the clock and startMs + f * (endMs - startMs) in time.
 */

import type { TimelineData, TimelinePoint } from '@/hooks/useObservatoryLenses';
import { CYCLE_LENGTH } from '../trips';

const BUCKET_MS: Record<TimelineData['bucket'], number> = { '1h': 3_600_000, '6h': 21_600_000, '1d': 86_400_000 };

export interface HistBar {
  startMs: number;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface Histogram {
  bars: HistBar[];
  startMs: number;
  /** End of the last bucket. */
  endMs: number;
  bucketMs: number;
  max: number;
  total: number;
}

export function buildHistogram(data: TimelineData | undefined): Histogram | null {
  if (!data || !Array.isArray(data.points) || data.points.length === 0) return null;
  const bucketMs = BUCKET_MS[data.bucket] ?? BUCKET_MS['1h'];
  const bars: HistBar[] = [];
  let max = 0;
  let total = 0;
  for (const p of data.points as TimelinePoint[]) {
    const startMs = Date.parse(p.t);
    if (!Number.isFinite(startMs)) continue;
    bars.push({ startMs, total: p.total, critical: p.critical, high: p.high, medium: p.medium, low: p.low });
    if (p.total > max) max = p.total;
    total += p.total;
  }
  if (bars.length === 0) return null;
  bars.sort((a, b) => a.startMs - b.startMs);
  return { bars, startMs: bars[0]!.startMs, endMs: bars[bars.length - 1]!.startMs + bucketMs, bucketMs, max, total };
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Largest playhead: a hair under the cycle so a scrub to the far right doesn't wrap to 0. */
export const MAX_PLAYHEAD = CYCLE_LENGTH - 1e-3;

export function fracToClock(frac: number, cycle: number = CYCLE_LENGTH): number {
  return Math.min(clamp01(frac) * cycle, cycle - 1e-3);
}

export function clockToFrac(t: number, cycle: number = CYCLE_LENGTH): number {
  return clamp01(t / cycle);
}

export function fracToTime(frac: number, h: Pick<Histogram, 'startMs' | 'endMs'>): number {
  return h.startMs + clamp01(frac) * (h.endMs - h.startMs);
}

/** Pointer x inside [left, left + width] -> fraction in [0, 1]. */
export function pointerFrac(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  return clamp01((clientX - left) / width);
}

export function bucketIndexAt(frac: number, bucketCount: number): number {
  if (bucketCount <= 0) return 0;
  return Math.min(bucketCount - 1, Math.floor(clamp01(frac) * bucketCount));
}

/** Move the playhead one bucket (or `coarse` buckets) left / right, clamped to the bar. */
export function nudgePlayhead(t: number, direction: -1 | 1, bucketCount: number, coarse = 1, cycle: number = CYCLE_LENGTH): number {
  const step = (cycle / Math.max(1, bucketCount)) * coarse;
  return Math.min(Math.max(0, t + direction * step), cycle - 1e-3);
}

export interface PathSet {
  critical: string;
  high: string;
  medium: string;
  low: string;
  other: string;
}

/**
 * One SVG path string per severity, each bar a rectangle, stacked
 * critical (bottom) -> high -> medium -> low -> other. Four <path>s instead of
 * ~170 × 4 elements.
 */
export function stackedPaths(h: Histogram, width: number, height: number, gap = 0.5): PathSet {
  const out: PathSet = { critical: '', high: '', medium: '', low: '', other: '' };
  if (h.max <= 0 || width <= 0 || height <= 0) return out;
  const n = h.bars.length;
  const bw = width / n;
  const w = Math.max(0.5, bw - gap);
  const scale = (height - 1) / h.max;
  const f = (x: number): string => (Math.round(x * 100) / 100).toString();
  h.bars.forEach((b, i) => {
    const x = i * bw + gap / 2;
    let y = height;
    const seg = (key: keyof PathSet, v: number): void => {
      if (v <= 0) return;
      const ph = v * scale;
      y -= ph;
      out[key] += `M${f(x)} ${f(y)}h${f(w)}v${f(ph)}h${f(-w)}z`;
    };
    const known = b.critical + b.high + b.medium + b.low;
    seg('critical', b.critical);
    seg('high', b.high);
    seg('medium', b.medium);
    seg('low', b.low);
    seg('other', Math.max(0, b.total - known));
  });
  return out;
}

export function formatPlayheadTime(ms: number, bucketMs: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  if (bucketMs >= 86_400_000) return date;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${date} ${time} UTC`;
}
