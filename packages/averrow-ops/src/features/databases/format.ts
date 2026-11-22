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

export function formatTimeToFull(d: Pick<DatabaseEntry, 'days_to_cap' | 'growth_bytes_per_day'>): string {
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

export const STORE_ORDER: DbStore[] = ['core', 'geo', 'dnsq', 'audit'];

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
