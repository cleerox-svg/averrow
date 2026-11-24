// Formatting + derivation helpers for the Databases page. Null always renders
// as an explicit dash, never 0.

import type { DatabaseEntry, DbEdge, DbEdgeKind, DbStatus, DbStore } from '@/hooks/useDatabases';

export const DASH = '—';

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : abs >= 1e7 ? 1 : 2)} M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : abs >= 1e4 ? 1 : 2)} K`;
  return String(Math.round(n));
}

export function formatPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return `${n.toFixed(digits)}%`;
}

export function usedPct(size: number | null, cap: number): number | null {
  if (size == null || cap <= 0) return null;
  return (size / cap) * 100;
}

export const DEFAULT_WARN_FRACTION = 0.5;
export const DEFAULT_CRITICAL_FRACTION = 0.8;
export const OVERLOADS_SCOPE_DEFAULT = 'from metered jobs';

export function thresholds(
  s: { thresholds?: { warn_size_fraction?: number; critical_size_fraction?: number } } | undefined,
) {
  return {
    warn: s?.thresholds?.warn_size_fraction ?? DEFAULT_WARN_FRACTION,
    critical: s?.thresholds?.critical_size_fraction ?? DEFAULT_CRITICAL_FRACTION,
  };
}

const OVERLOADS_SCOPE_TEXT: Record<string, string> = { metered_jobs: OVERLOADS_SCOPE_DEFAULT };

/** Display text for the server's `overloads_scope` token; never prints the raw token. */
export function overloadsScopeText(scope: string | undefined): string {
  return (scope != null && OVERLOADS_SCOPE_TEXT[scope]) || OVERLOADS_SCOPE_DEFAULT;
}

export const thresholdText = (t: { warn: number; critical: number }) =>
  `Check at ${Math.round(t.warn * 100)}% · critical at ${Math.round(t.critical * 100)}%`;

export function overCap(d: Pick<DatabaseEntry, 'size_bytes' | 'cap_bytes'>): boolean {
  return d.size_bytes != null && d.size_bytes >= d.cap_bytes;
}

export function formatTimeToFull(d: Pick<DatabaseEntry, 'days_to_cap' | 'growth_bytes_per_day'> & Partial<Pick<DatabaseEntry, 'size_bytes' | 'cap_bytes'>>): string {
  if (d.size_bytes != null && d.cap_bytes != null && d.size_bytes >= d.cap_bytes) return 'At or over the cap';
  if (d.growth_bytes_per_day == null) return 'Not enough history yet';
  if (d.growth_bytes_per_day <= 0) return 'Flat, not growing';
  if (d.days_to_cap == null) return 'Not enough history yet';
  const days = d.days_to_cap;
  if (days < 1) return 'Under a day to full';
  if (days < 60) return `≈ ${Math.round(days)} days to full`;
  if (days < 730) return `≈ ${Math.round(days / 30)} months to full`;
  return `≈ ${(days / 365).toFixed(1)} years to full`;
}

export const STATUS_LABEL: Record<DbStatus, string> = {
  healthy: 'Healthy',
  warning: 'Check',
  overloaded: 'Overloaded',
  unknown: 'Unknown',
};

export const STORE_ORDER: DbStore[] = ['core', 'telemetry', 'geo', 'dnsq', 'archive', 'audit'];

export const KIND_LABEL: Record<DbEdgeKind, string> = {
  agent: 'Agents',
  feed: 'Feeds',
  cron: 'Cron jobs',
  workflow: 'Workflows',
  http: 'Web & API',
};
export const KIND_ORDER: DbEdgeKind[] = ['agent', 'feed', 'cron', 'workflow', 'http'];

export const WINDOW_LABEL = { '1h': 'Last hour', '24h': 'Last 24 h', cycle: 'Billing cycle' } as const;

export function peakHour(hourly: DatabaseEntry['hourly']): { hour: string; rows_read: number } | null {
  let best: { hour: string; rows_read: number } | null = null;
  for (const h of hourly) if (!best || h.rows_read > best.rows_read) best = { hour: h.hour, rows_read: h.rows_read };
  return best && best.rows_read > 0 ? best : null;
}

export function hourLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

export interface SourceNode {
  id: string;
  source: string;
  kind: DbEdgeKind;
  rows_read: number;
}

/** Unique job nodes from edges, grouped by kind then heaviest first. */
export function sourceNodes(edges: DbEdge[]): SourceNode[] {
  const map = new Map<string, SourceNode>();
  for (const e of edges) {
    const id = `${e.kind}:${e.source}`;
    const n = map.get(id) ?? { id, source: e.source, kind: e.kind, rows_read: 0 };
    n.rows_read += e.rows_read;
    map.set(id, n);
  }
  return [...map.values()].sort((a, b) => {
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return k !== 0 ? k : b.rows_read - a.rows_read || a.source.localeCompare(b.source);
  });
}

export const edgeId = (e: Pick<DbEdge, 'kind' | 'source' | 'store'>) => `${e.kind}:${e.source}>${e.store}`;

export function findStore(dbs: DatabaseEntry[], store: string | null): DatabaseEntry | undefined {
  return store ? dbs.find((d) => d.store === store) : undefined;
}

// ─── Last 24 h vs the billing cycle's daily average ─────────────

/** Within ±this % of the cycle average reads as "about average" (no colour). */
export const CYCLE_TREND_FLAT_PCT = 10;
/** Below this many rows a day a store is too quiet for a percentage to mean anything. */
export const CYCLE_TREND_MIN_ROWS_PER_DAY = 1_000;
/** Fewer complete hours than this in the recent window → no trend. */
const MIN_RECENT_HOURS = 12;
const HOUR_MS = 3_600_000;

export interface CycleTrend {
  /** The cycle's pace per day BEFORE the recent window (so the window doesn't pull its own baseline toward it). */
  dailyAvg: number;
  /** The recent window's pace per day (its complete hours, scaled to 24 h). */
  last24h: number;
  /** (last24h ÷ dailyAvg − 1) × 100, rounded. */
  deltaPct: number;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Compare the last day with the rest of the billing cycle, as per-day rates.
 *
 * The recent window is the complete hours of the store's `hourly` series (the
 * newest bucket is the hour still in progress, so it is left out; the
 * `reads_24h` figure is not used because its window starts mid-hour). The
 * baseline is the cycle total minus everything from the recent window's first
 * hour on, over the hours between the cycle start and that hour.
 *
 * Null when data is missing, the baseline is under a day, or the store is too
 * quiet (< {@link CYCLE_TREND_MIN_ROWS_PER_DAY}/day). `now` should be the
 * payload's `generated_at`.
 */
export function cycleTrend(
  cycleTotal: number | null | undefined,
  hourly: ReadonlyArray<{ hour: string; rows_read: number; rows_written: number }> | null | undefined,
  field: 'rows_read' | 'rows_written',
  cycleStart: string | null | undefined,
  now: string | number | Date,
): CycleTrend | null {
  if (cycleTotal == null || !hourly || hourly.length === 0 || !cycleStart) return null;
  const start = Date.parse(cycleStart);
  const at = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return null;

  let recentSum = 0;
  let recentHours = 0;
  let firstRecent = Infinity;
  let afterRecent = 0; // the in-progress hour: in the cycle total, in neither window
  for (const h of hourly) {
    const t = Date.parse(h.hour);
    if (!Number.isFinite(t) || t < start) continue;
    if (t + HOUR_MS <= at) {
      recentSum += h[field];
      recentHours++;
      firstRecent = Math.min(firstRecent, t);
    } else {
      afterRecent += h[field];
    }
  }
  if (recentHours < MIN_RECENT_HOURS) return null;

  const baselineHours = (firstRecent - start) / HOUR_MS;
  if (baselineHours < 24) return null;
  const baselineTotal = cycleTotal - recentSum - afterRecent;
  const dailyAvg = (baselineTotal / baselineHours) * 24;
  if (!(dailyAvg >= CYCLE_TREND_MIN_ROWS_PER_DAY)) return null;

  const last24h = (recentSum / recentHours) * 24;
  const deltaPct = Math.round((last24h / dailyAvg - 1) * 100);
  const direction = Math.abs(deltaPct) < CYCLE_TREND_FLAT_PCT ? 'flat' : deltaPct > 0 ? 'up' : 'down';
  return { dailyAvg, last24h, deltaPct, direction };
}

/** Chip text: "▲ 18%", "▼ 9%" or "≈ avg". */
export function cycleTrendChip(t: CycleTrend): string {
  if (t.direction === 'flat') return '≈ avg';
  return `${t.direction === 'up' ? '▲' : '▼'} ${Math.abs(t.deltaPct)}%`;
}

/** Full sentence for screen readers. `what` is "rows read" / "rows written". */
export function cycleTrendLabel(t: CycleTrend, what: string): string {
  const vs = t.direction === 'flat'
    ? 'about the same as'
    : `${Math.abs(t.deltaPct)}% ${t.direction === 'up' ? 'above' : 'below'}`;
  return `Last 24 h: about ${formatCount(t.last24h)} ${what}, ${vs} this cycle's earlier daily average of ${formatCount(t.dailyAvg)}`;
}

/** At or above this % over the average (2× normal), an increase is red rather than amber. */
export const CYCLE_TREND_HIGH_PCT = 100;

export type CycleTrendTone = 'good' | 'warn' | 'bad' | 'neutral';

/**
 * Colour for a trend. More usage costs more: amber above the ±10% band, red
 * at 2× the average or more. Fewer READS is good (green). Fewer WRITES is
 * neutral, not good: a drop in writes can mean a stalled feed or agent.
 */
export function cycleTrendTone(t: CycleTrend, field: 'rows_read' | 'rows_written'): CycleTrendTone {
  if (t.direction === 'up') return t.deltaPct >= CYCLE_TREND_HIGH_PCT ? 'bad' : 'warn';
  if (t.direction === 'down') return field === 'rows_read' ? 'good' : 'neutral';
  return 'neutral';
}
