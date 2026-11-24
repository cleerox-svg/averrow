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

export interface CycleTrend {
  /** Cycle total ÷ days elapsed in the cycle. */
  dailyAvg: number;
  last24h: number;
  /** (last 24 h ÷ daily average − 1) × 100, rounded. */
  deltaPct: number;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Compare the last 24 h against the cycle's average day. Null when any input
 * is missing or the cycle is less than a day old (its "average" would be the
 * same 24 h). `now` should be the payload's `generated_at`, so a cached
 * payload is measured against the moment its numbers were taken.
 */
export function cycleTrend(
  cycleTotal: number | null | undefined,
  last24h: number | null | undefined,
  cycleStart: string | null | undefined,
  now: string | number | Date,
): CycleTrend | null {
  if (cycleTotal == null || last24h == null || !cycleStart) return null;
  const start = Date.parse(cycleStart);
  const at = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return null;
  const days = (at - start) / 86_400_000;
  if (days < 1) return null;
  const dailyAvg = cycleTotal / days;
  if (!(dailyAvg > 0)) return null;
  const deltaPct = Math.round((last24h / dailyAvg - 1) * 100);
  const direction = Math.abs(deltaPct) < CYCLE_TREND_FLAT_PCT ? 'flat' : deltaPct > 0 ? 'up' : 'down';
  return { dailyAvg, last24h, deltaPct, direction };
}

/** Chip text: "▲ 18%", "▼ 9%" or "≈ avg". */
export function cycleTrendChip(t: CycleTrend): string {
  if (t.direction === 'flat') return '≈ avg';
  return `${t.direction === 'up' ? '▲' : '▼'} ${Math.abs(t.deltaPct)}%`;
}

/** Full sentence for screen readers and hover. `what` is "rows read" / "rows written". */
export function cycleTrendLabel(t: CycleTrend, what: string): string {
  const vs = t.direction === 'flat'
    ? 'about the same as'
    : `${Math.abs(t.deltaPct)}% ${t.direction === 'up' ? 'above' : 'below'}`;
  return `Last 24 h: ${formatCount(t.last24h)} ${what}, ${vs} this cycle's daily average of ${formatCount(t.dailyAvg)}`;
}

/** More reads or writes than usual costs more, so up is "bad" (red) and down is "good" (green). */
export function cycleTrendTone(t: CycleTrend): 'good' | 'bad' | 'neutral' {
  return t.direction === 'up' ? 'bad' : t.direction === 'down' ? 'good' : 'neutral';
}
