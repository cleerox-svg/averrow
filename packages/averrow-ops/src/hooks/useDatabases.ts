import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Contract: GET /api/databases?window=1h|24h|cycle (requireStaff). Every
// number that depends on the per-store D1 meter may be null (not measured
// yet); a section that errored server-side adds `<section>_error`.

export type DbStore = 'core' | 'audit' | 'geo' | 'dnsq' | 'telemetry' | 'archive';
export type DbStatus = 'healthy' | 'warning' | 'overloaded' | 'unknown';
export type DbEdgeKind = 'agent' | 'feed' | 'cron' | 'workflow' | 'http';
export type DbWindow = '1h' | '24h' | 'cycle';

export interface DbHourly {
  hour: string;
  rows_read: number;
  rows_written: number;
  overloads: number | null;
}

export interface DbTable {
  name: string;
  rows_estimate: number | null;
  bytes: number | null;
  estimate_divergent?: boolean;
}

export interface DbJob {
  source: string;
  kind: DbEdgeKind;
  rows_read: number;
  rows_written: number;
  overloads: number | null;
}

export interface DatabaseEntry {
  store: DbStore;
  name: string;
  binding: string;
  role: string;
  label: string;
  status: DbStatus;
  status_reasons: string[];
  size_bytes: number | null;
  cap_bytes: number;
  size_source: 'cf_api' | 'pragma' | null;
  tables: number | null;
  growth_bytes_per_day: number | null;
  days_to_cap: number | null;
  size_history: Array<{ date: string; bytes: number }>;
  reads_6h: number | null;
  writes_6h: number | null;
  reads_24h: number | null;
  writes_24h: number | null;
  reads_cycle: number | null;
  writes_cycle: number | null;
  hourly: DbHourly[];
  overloads_24h: number | null;
  top_tables: DbTable[];
  top_jobs: DbJob[];
  note: string | null;
  /** telemetry store only: which DB serves the telemetry tables right now. */
  route?: 'core' | 'telemetry';
}

export interface DbProposed {
  name: string;
  role: string;
  description: string;
}

export interface DbEdge {
  source: string;
  kind: DbEdgeKind;
  store: DbStore;
  rows_read: number;
  rows_written: number;
  queries: number;
  overloads: number | null;
}

export interface DatabasesSummary {
  live: number;
  proposed: number;
  total_bytes: number | null;
  largest_share_pct: number | null;
  cycle_rows_read: number | null;
  cycle_pct_of_plan: number | null;
  overloads_24h: number | null;
  /** Server thresholds (lib/db-health.ts). Defaults 0.5 / 0.8 when absent. */
  thresholds?: {
    warn_size_fraction?: number;
    critical_size_fraction?: number;
    warn_days_to_cap?: number;
    overloaded_min?: number;
  };
  /** What overload counts cover: 'metered_jobs' (HTTP traffic is not metered yet). */
  overloads_scope?: string;
}

export interface DatabasesPayload {
  generated_at: string;
  window: DbWindow;
  summary: DatabasesSummary;
  databases: DatabaseEntry[];
  proposed: DbProposed[];
  edges: DbEdge[];
  overloads_scope?: string;
  /** Fail-soft: `<section>_error` keys name a section that fell back server-side. */
  [sectionError: `${string}_error`]: string | undefined;
}

export function useDatabases(window: DbWindow = '24h') {
  return useQuery({
    queryKey: ['databases', window],
    queryFn: async () => {
      const res = await api.get<DatabasesPayload>(`/api/databases?window=${window}`);
      if (!res.data) throw new Error(res.error ?? 'No database data returned');
      return res.data;
    },
    placeholderData: keepPreviousData,
    // The server caches for 10 min; poll gently.
    refetchInterval: 120_000,
  });
}

/** Names of payload sections that fell back server-side (`<section>_error`). */
export function sectionErrors(p: DatabasesPayload): string[] {
  const rec = p as unknown as Record<string, unknown>;
  return Object.keys(rec)
    .filter((k) => k.endsWith('_error') && typeof rec[k] === 'string')
    .map((k) => k.slice(0, -'_error'.length));
}
