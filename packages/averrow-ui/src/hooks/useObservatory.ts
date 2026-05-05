import { useObservatoryQuery } from './useObservatoryQuery';
import type { UseObservatoryQueryResult } from './useObservatoryQuery';

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
  brand_name: string | null;
  volume: number;
  first_seen?: string;
  last_seen?: string;
}

export interface HeatmapPoint {
  lat: number;
  lng: number;
  severity: string;
  threat_type: string;
}

export function useObservatoryThreats(
  options?: { period?: string; source?: string; limit?: number }
): UseObservatoryQueryResult<ThreatPoint[]> {
  const { period = '7d', source = 'all', limit = 2000 } = options || {};

  return useObservatoryQuery<ThreatPoint[]>(
    '/api/observatory/nodes',
    { period, source_feed: source === 'all' ? '' : source, limit },
    { refetchInterval: 300_000 },
  );
}

export function useObservatoryStats(
  options?: { period?: string; source?: string }
): UseObservatoryQueryResult<ObservatoryStats> {
  const { period = '7d', source = 'all' } = options || {};

  return useObservatoryQuery<ObservatoryStats>(
    '/api/observatory/stats',
    { period, source_feed: source === 'all' ? '' : source },
    { refetchInterval: 300_000 },
  );
}

export function useObservatoryArcs(
  options?: { period?: string; source?: string }
): UseObservatoryQueryResult<ArcData[]> {
  const { period = '7d', source = 'all' } = options || {};

  return useObservatoryQuery<ArcData[]>(
    '/api/observatory/arcs',
    { period, source_feed: source === 'all' ? '' : source },
    { refetchInterval: 300_000 },
  );
}

export function useObservatoryHeatmap(
  options?: { period?: string; limit?: number }
): UseObservatoryQueryResult<HeatmapPoint[]> {
  const { period = '7d', limit = 10000 } = options || {};

  return useObservatoryQuery<HeatmapPoint[]>(
    '/api/threats/heatmap',
    { period, limit },
    { refetchInterval: 300_000 },
  );
}
