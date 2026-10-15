/**
 * Observatory data hooks (TanStack Query).
 *
 * One query per key: every consumer of the same (endpoint, period, source,
 * limit) shares a single cached entry, a single in-flight request and a single
 * poll timer — the map and the side panel no longer fetch the same data twice.
 *
 *  - Polling: `refetchInterval` with `refetchIntervalInBackground: false`, so a
 *    hidden tab stops polling.
 *  - Period/source switches keep the previous data on screen
 *    (`placeholderData: keepPreviousData`) but expose `isUpdating` so the UI can
 *    say so instead of silently labelling old data as new.
 *  - Gating: every hook takes `enabled`; callers only enable what the current
 *    map mode actually renders.
 *  - Cancellation: the query's own AbortSignal is passed to fetch, so React
 *    Query (not a shared promise) owns abort semantics.
 *
 * Cache lifetime: the in-memory QueryClient dies with the page, and logout
 * ends in a full-page navigation (`@averrow/shared/auth` teardown →
 * `window.location.href`), so nothing here outlives the session.
 */

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────

export interface ThreatPoint {
  lat: number;
  lng: number;
  threat_count: number;
  top_severity: string | null;
  critical: number;
  high: number;
  medium: number;
  low: number;
  country_code: string | null;
  top_threat_type: string | null;
}

export interface ObservatoryStats {
  threats_mapped: number;
  /** All threats ingested in the same window (no lat/lng requirement). */
  threats_total: number;
  /** Integer percentage; null when threats_total is 0. */
  geo_coverage_pct: number | null;
  countries: number;
  active_campaigns: number;
  brands_monitored: number;
  period: string;
}

export interface ArcData {
  sourcePosition: [number, number];
  targetPosition: [number, number];
  threat_type: string;
  severity: string;
  source_region: string;
  target_brand: string;
  /** `brands.id`: the value of the `brand` filter. Absent on payloads cached before the server sent it. */
  target_brand_id?: string | null;
  brand_name: string | null;
  volume: number;
  first_seen?: string;
  last_seen?: string;
  /**
   * Whether `targetPosition` is the brand HQ or only a country centroid.
   * Absent on older payloads — treat as 'hq'.
   */
  target_precision?: 'hq' | 'country';
}

export interface HeatmapPoint {
  lat: number;
  lng: number;
  severity: string;
  threat_type: string;
  /** Server-computed weight; absent on older payloads (fall back to severity weight). */
  weight?: number;
}

export interface LiveThreatEntry {
  id: string;
  threat_type: string;
  severity: string | null;
  country_code: string | null;
  created_at: string;
  malicious_domain: string | null;
}

/** Common result shape. `data` is `undefined` until the first successful load. */
export interface ObservatoryQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  /** First load for this key with nothing to show. */
  isLoading: boolean;
  /** Any request in flight (initial, background poll, manual refresh). */
  isFetching: boolean;
  /** `data` belongs to the PREVIOUS key (period/source just changed) and the new one is loading. */
  isUpdating: boolean;
  refetch: () => Promise<unknown>;
}

// ─── Keys & params ──────────────────────────────────────────

export const OBSERVATORY_POLL_MS = 300_000;
export const OBSERVATORY_STALE_MS = 60_000;
export const NODES_MAX_LIMIT = 2000;
export const HEATMAP_DEFAULT_LIMIT = 10_000;
export const LIVE_FEED_LIMIT = 8;

/**
 * Data filters for nodes / arcs / stats. Every field is optional and an empty one is NOT sent, so an unfiltered view keeps
 * the exact URL and query key it always had. Param names are the backend contract: `severity`, `threat_type`, `brand`.
 */
export interface ObservatoryFilters {
  /** Comma-separated severities (`critical,high`). */
  severity?: string;
  /** Comma-separated threat types (`phishing,malware`). */
  threat_type?: string;
  /** Brand ID (`brands.id`, e.g. from an arc's `target_brand_id`), never a name. */
  brand?: string;
}

/** The filters that are actually set (trimmed, non-empty), or null when there are none. */
export function activeFilters(f: ObservatoryFilters | undefined): ObservatoryFilters | null {
  if (!f) return null;
  const out: ObservatoryFilters = {};
  if (f.severity?.trim()) out.severity = f.severity.trim();
  if (f.threat_type?.trim()) out.threat_type = f.threat_type.trim();
  if (f.brand?.trim()) out.brand = f.brand.trim();
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * `/nodes` has no brand dimension (the geo cube is brand-less) and answers 400 to `brand`: the node layer drops it, so a
 * brand filter narrows the arcs and stats but leaves the nodes as they are.
 */
export function withoutBrand(f: ObservatoryFilters | undefined): ObservatoryFilters | undefined {
  if (!f || f.brand === undefined) return f;
  const { brand: _brand, ...rest } = f;
  void _brand;
  return rest;
}

/** Query-key fragment: `{}` when there is no filter (default keys unchanged), `{ filters }` otherwise. */
export function filterKey(f: ObservatoryFilters | undefined): { filters?: ObservatoryFilters } {
  const a = activeFilters(f);
  return a ? { filters: a } : {};
}

/** URL params for the filters that are set (undefined entries are dropped by `buildObservatoryUrl`). */
export function filterParams(f: ObservatoryFilters | undefined): Record<string, string | undefined> {
  const a = activeFilters(f);
  return a ? { severity: a.severity, threat_type: a.threat_type, brand: a.brand } : {};
}

export const observatoryKeys = {
  all: ['observatory'] as const,
  /** Phase B lens endpoints share this root so `refreshObservatory` invalidates them too. */
  lens: (name: string, params: Record<string, string | number | null | undefined> = {}) => ['observatory', 'lens', name, params] as const,
  nodes: (period: string, source: string, limit: number, filters?: ObservatoryFilters) => ['observatory', 'nodes', { period, source, limit, ...filterKey(filters) }] as const,
  stats: (period: string, source: string, filters?: ObservatoryFilters) => ['observatory', 'stats', { period, source, ...filterKey(filters) }] as const,
  arcs: (period: string, source: string, filters?: ObservatoryFilters) => ['observatory', 'arcs', { period, source, ...filterKey(filters) }] as const,
  heatmap: (period: string, source: string, limit: number) => ['observatory', 'heatmap', { period, source, limit }] as const,
  live: (source: string, limit: number) => ['observatory', 'live', { source, limit }] as const,
};

/** 'all' (and empty) means "no source filter" — the param is omitted. */
export function sourceParam(source: string | undefined): string | undefined {
  return !source || source === 'all' ? undefined : source;
}

export function clampLimit(limit: number, min: number, max: number): number {
  if (!Number.isFinite(limit)) return max;
  return Math.min(max, Math.max(min, Math.floor(limit)));
}

/** Build `endpoint?a=1&b=2`, dropping undefined / empty values. */
export function buildObservatoryUrl(endpoint: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${endpoint}?${s}` : endpoint;
}

async function fetchObservatory<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await api.fetch<T>(url, { signal });
  if (!res.success) throw new Error(res.error || 'Observatory request failed');
  return res.data ?? null;
}

interface CommonOptions {
  enabled?: boolean;
}

interface ListOptions extends CommonOptions {
  period?: string;
  source?: string;
  /** Severity / threat type / brand. Only the ones that are set are sent (nodes, arcs and stats). */
  filters?: ObservatoryFilters;
}

export function shape<T>(q: {
  data: T | undefined; error: Error | null; isLoading: boolean; isFetching: boolean;
  isPlaceholderData: boolean; refetch: () => Promise<unknown>;
}): ObservatoryQueryResult<T> {
  return {
    data: q.data,
    error: q.error,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    isUpdating: q.isPlaceholderData,
    refetch: q.refetch,
  };
}

export const POLL = {
  refetchInterval: OBSERVATORY_POLL_MS,
  refetchIntervalInBackground: false,
  staleTime: OBSERVATORY_STALE_MS,
  placeholderData: keepPreviousData,
} as const;

// ─── Hooks ──────────────────────────────────────────────────

export function useObservatoryThreats(
  options: ListOptions & { limit?: number } = {},
): ObservatoryQueryResult<ThreatPoint[]> {
  const { period = '7d', source = 'all', limit = NODES_MAX_LIMIT, enabled = true } = options;
  const filters = withoutBrand(options.filters);
  const safeLimit = clampLimit(limit, 1, NODES_MAX_LIMIT);
  const q = useQuery({
    queryKey: observatoryKeys.nodes(period, source, safeLimit, filters),
    queryFn: async ({ signal }) =>
      (await fetchObservatory<ThreatPoint[]>(
        buildObservatoryUrl('/api/observatory/nodes', { period, source_feed: sourceParam(source), limit: safeLimit, ...filterParams(filters) }),
        signal,
      )) ?? [],
    enabled,
    ...POLL,
  });
  return shape(q);
}

export function useObservatoryStats(options: ListOptions = {}): ObservatoryQueryResult<ObservatoryStats> {
  const { period = '7d', source = 'all', enabled = true, filters } = options;
  const q = useQuery({
    queryKey: observatoryKeys.stats(period, source, filters),
    queryFn: async ({ signal }) => {
      const data = await fetchObservatory<ObservatoryStats>(
        buildObservatoryUrl('/api/observatory/stats', { period, source_feed: sourceParam(source), ...filterParams(filters) }),
        signal,
      );
      if (!data) throw new Error('Observatory stats unavailable');
      return data;
    },
    enabled,
    ...POLL,
  });
  return shape(q);
}

export function useObservatoryArcs(options: ListOptions = {}): ObservatoryQueryResult<ArcData[]> {
  const { period = '7d', source = 'all', enabled = true, filters } = options;
  const q = useQuery({
    queryKey: observatoryKeys.arcs(period, source, filters),
    queryFn: async ({ signal }) =>
      (await fetchObservatory<ArcData[]>(
        buildObservatoryUrl('/api/observatory/arcs', { period, source_feed: sourceParam(source), ...filterParams(filters) }),
        signal,
      )) ?? [],
    enabled,
    ...POLL,
  });
  return shape(q);
}

export function useObservatoryHeatmap(
  options: ListOptions & { limit?: number } = {},
): ObservatoryQueryResult<HeatmapPoint[]> {
  const { period = '7d', source = 'all', limit = HEATMAP_DEFAULT_LIMIT, enabled = true } = options;
  const q = useQuery({
    queryKey: observatoryKeys.heatmap(period, source, limit),
    queryFn: async ({ signal }) =>
      (await fetchObservatory<HeatmapPoint[]>(
        buildObservatoryUrl('/api/observatory/heatmap', { period, source_feed: sourceParam(source), limit }),
        signal,
      )) ?? [],
    enabled,
    ...POLL,
  });
  return shape(q);
}

/** Side-panel live feed. Polls faster than the map (15s) but also pauses in background tabs. */
export function useObservatoryLive(
  options: CommonOptions & { source?: string; limit?: number } = {},
): ObservatoryQueryResult<LiveThreatEntry[]> {
  const { source = 'all', limit = LIVE_FEED_LIMIT, enabled = true } = options;
  const q = useQuery({
    queryKey: observatoryKeys.live(source, limit),
    queryFn: async ({ signal }) =>
      (await fetchObservatory<LiveThreatEntry[]>(
        buildObservatoryUrl('/api/observatory/live', { limit, source_feed: sourceParam(source) }),
        signal,
      )) ?? [],
    enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  return shape(q);
}

// ─── Refresh ────────────────────────────────────────────────

/** Query-key roots owned by the side panel's non-observatory widgets. */
const SIDE_PANEL_ROOTS = new Set(['dashboard-providers', 'operations', 'geo-campaigns', 'agents']);

/**
 * Invalidate everything the Observatory page shows: all observatory queries
 * plus the side panel's brand / provider / operation / campaign / agent
 * widgets. Only mounted (active) queries refetch; the rest are just marked stale.
 */
export function refreshObservatory(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({
    predicate: (query) => {
      const [root, second] = query.queryKey;
      if (root === 'observatory') return true;
      if (root === 'brands') return second === 'top';
      return typeof root === 'string' && SIDE_PANEL_ROOTS.has(root);
    },
  });
}

export function useRefreshObservatory(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(() => refreshObservatory(qc), [qc]);
}
