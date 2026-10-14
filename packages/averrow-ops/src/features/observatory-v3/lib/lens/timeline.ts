/**
 * Replay timeline model: bucketing the /timeline series into a histogram and
 * mapping a pointer / key / clock position <-> time <-> AnimationClock playhead.
 *
 * The clock loops over CYCLE_LENGTH units that represent the whole selected
 * period (the same mapping the particles and the movement trails use), so a
 * fraction f of the bar is f * CYCLE_LENGTH on the clock and startMs + f *
 * (endMs - startMs) in time. Pass the REPLAY WINDOW ([now - period, now], the one
 * the particles were built for) to `buildHistogram` and bars are placed by their
 * real time inside it, so the playhead, the bars and the particles share a window
 * instead of the bars being stretched over whatever buckets the server returned.
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
  /** Fast-weaponization counts (velocity series only; 0 otherwise). */
  veryFast: number;
  fast: number;
}

/** Which series the bars show: threats by severity, or fast-weaponized threats (`/timeline?velocity=`). */
export type TimelineSeries = 'severity' | 'velocity';

export interface Histogram {
  bars: HistBar[];
  startMs: number;
  /** End of the last bucket. */
  endMs: number;
  bucketMs: number;
  max: number;
  total: number;
  series: TimelineSeries;
}

export interface ReplayWindow { startMs: number; endMs: number }

export function buildHistogram(data: TimelineData | undefined, window?: ReplayWindow | null, series: TimelineSeries = 'severity'): Histogram | null {
  if (!data || !Array.isArray(data.points) || data.points.length === 0) return null;
  const bucketMs = BUCKET_MS[data.bucket] ?? BUCKET_MS['1h'];
  const bars: HistBar[] = [];
  let max = 0;
  let total = 0;
  for (const p of data.points as TimelinePoint[]) {
    const startMs = Date.parse(p.t);
    if (!Number.isFinite(startMs)) continue;
    // The velocity series is the fast-weaponized count; its severity fields are always 0 (the cube has none).
    const veryFast = series === 'velocity' ? Math.max(0, p.very_fast ?? 0) : 0;
    const fast = series === 'velocity' ? Math.max(0, p.fast ?? 0) : 0;
    const t = series === 'velocity' ? veryFast + fast : p.total;
    bars.push({ startMs, total: t, critical: p.critical, high: p.high, medium: p.medium, low: p.low, veryFast, fast });
    if (t > max) max = t;
    total += t;
  }
  if (bars.length === 0) return null;
  bars.sort((a, b) => a.startMs - b.startMs);
  const aligned = !!window && window.endMs > window.startMs;
  return {
    bars,
    startMs: aligned ? window.startMs : bars[0]!.startMs,
    endMs: aligned ? window.endMs : bars[bars.length - 1]!.startMs + bucketMs,
    bucketMs, max, total, series,
  };
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

/** Index of the bar the playhead is over (by real time, so it stays right when the window is offset from the buckets). */
export function barIndexAt(frac: number, h: Pick<Histogram, 'bars' | 'startMs' | 'endMs' | 'bucketMs'>): number {
  if (h.bars.length === 0) return 0;
  const t = fracToTime(frac, h);
  const i = Math.floor((t - h.bars[0]!.startMs) / h.bucketMs);
  return Math.min(h.bars.length - 1, Math.max(0, i));
}

/** How many buckets the replay window spans (the playhead's keyboard step is one of them). */
export function windowBuckets(h: Pick<Histogram, 'startMs' | 'endMs' | 'bucketMs'>): number {
  return Math.max(1, (h.endMs - h.startMs) / h.bucketMs);
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
  const span = h.endMs - h.startMs;
  if (!(span > 0)) return out;
  const scale = (height - 1) / h.max;
  const f = (x: number): string => (Math.round(x * 100) / 100).toString();
  for (const b of h.bars) {
    // By real time inside the window, clipped to it.
    const x0 = Math.max(0, ((b.startMs - h.startMs) / span) * width);
    const x1 = Math.min(width, ((b.startMs + h.bucketMs - h.startMs) / span) * width);
    if (x1 <= x0) continue;
    const x = x0 + gap / 2;
    const w = Math.max(0.5, x1 - x0 - gap);
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
  }
  return out;
}

export interface VelocityPathSet {
  veryFast: string;
  fast: string;
}

/** The velocity series' bars: very fast at the bottom, fast on top. Same geometry as `stackedPaths`. */
export function velocityPaths(h: Histogram, width: number, height: number, gap = 0.5): VelocityPathSet {
  const out: VelocityPathSet = { veryFast: '', fast: '' };
  if (h.max <= 0 || width <= 0 || height <= 0) return out;
  const span = h.endMs - h.startMs;
  if (!(span > 0)) return out;
  const scale = (height - 1) / h.max;
  const f = (x: number): string => (Math.round(x * 100) / 100).toString();
  for (const b of h.bars) {
    const x0 = Math.max(0, ((b.startMs - h.startMs) / span) * width);
    const x1 = Math.min(width, ((b.startMs + h.bucketMs - h.startMs) / span) * width);
    if (x1 <= x0) continue;
    const x = x0 + gap / 2;
    const w = Math.max(0.5, x1 - x0 - gap);
    let y = height;
    const seg = (key: keyof VelocityPathSet, v: number): void => {
      if (v <= 0) return;
      const ph = v * scale;
      y -= ph;
      out[key] += `M${f(x)} ${f(y)}h${f(w)}v${f(ph)}h${f(-w)}z`;
    };
    seg('veryFast', b.veryFast);
    seg('fast', b.fast);
  }
  return out;
}

/** "13 Oct 14:00 UTC"; `short` drops the zone for a tight readout ("13 Oct 14:00"). */
export function formatPlayheadTime(ms: number, bucketMs: number, short = false): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  if (bucketMs >= 86_400_000) return date;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return short ? `${date} ${time}` : `${date} ${time} UTC`;
}
