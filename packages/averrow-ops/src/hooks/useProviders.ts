import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────

export interface Provider {
  id: string;
  name: string;
  asn: string | null;
  country: string | null;
  active_threat_count: number;
  total_threat_count: number;
  trend_7d: number | null;
  trend_30d: number | null;
  reputation_score: number | null;
  avg_response_time: number | null;
  is_bulletproof: number | null;
  first_threat: string | null;
  last_threat: string | null;
  threat_history?: number[];
}

export interface IntelligenceStats {
  total_providers: number;
  active_operations: number;
  accelerating: number;
  pivots_detected: number;
  total_clusters: number;
  active_clusters: number;
}

export interface Cluster {
  id: string;
  cluster_name: string | null;
  asns: string; // JSON array
  countries: string | null; // JSON array
  threat_count: number;
  status: string;
  confidence_score: number | null;
  agent_notes: string | null;
  first_detected: string | null;
  last_seen: string | null;
  last_updated: string | null;
}

export interface ProviderDetail {
  id: string;
  name: string;
  asn: string | null;
  country: string | null;
  reputation_score: number | null;
  avg_response_time: number | null;
  total_threats: number;
  active_threats: number;
  brands_targeted: number;
  campaigns: number;
  first_seen: string;
  last_seen: string;
  brand_breakdown: Array<{ brand_id: string | null; brand_name: string | null; count: number }>;
  type_breakdown: Array<{ threat_type: string; count: number }>;
}

export interface ProviderThreat {
  id: string;
  threat_type: string;
  severity: string;
  status: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  ip_address: string | null;
  country_code: string | null;
  target_brand_id: string | null;
  brand_name: string | null;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
}

export interface TimelineData {
  labels: string[];
  values: number[];
}

// ─── Intelligence Summary ─────────────────────────────────────

export function useProviderIntelligence() {
  return useQuery({
    queryKey: ['provider-intelligence'],
    queryFn: async () => {
      const res = await api.get<IntelligenceStats>('/api/providers/intelligence');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
  });
}

// ─── Provider List (v2 with status/sort/cluster filtering) ────

export function useProviders(options?: {
  view?: string;
  limit?: number;
  offset?: number;
  timeRange?: string;
  sort?: string;
  country?: string;
  status?: string;
  search?: string;
  clusterId?: string;
}) {
  const {
    limit = 50, offset = 0, sort = 'active_threats',
    timeRange, country, status, search, clusterId,
  } = options || {};

  return useQuery({
    queryKey: ['providers-v2', limit, offset, sort, timeRange, country, status, search, clusterId],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        sort,
      });
      if (timeRange) params.set('range', timeRange);
      if (country) params.set('country', country);
      if (status) params.set('status', status);
      if (search) params.set('q', search);
      if (clusterId) params.set('cluster_id', clusterId);
      const res = await api.get<Provider[]>(`/api/providers/v2?${params}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
  });
}

// ─── Clusters ─────────────────────────────────────────────────

export function useClusters() {
  return useQuery({
    queryKey: ['infrastructure-clusters'],
    queryFn: async () => {
      const res = await api.get<Cluster[]>('/api/providers/clusters');
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
  });
}

// ─── Provider Detail ──────────────────────────────────────────

export function useProviderDetail(providerId: string | null) {
  return useQuery({
    queryKey: ['provider', providerId],
    queryFn: async () => {
      const res = await api.get<ProviderDetail>(`/api/providers/${providerId}`);
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    enabled: !!providerId,
  });
}

// ─── Provider Threats ─────────────────────────────────────────

export function useProviderThreats(providerId: string | null, options?: { limit?: number; offset?: number; type?: string }) {
  const { limit = 10, offset = 0, type } = options || {};
  return useQuery({
    queryKey: ['provider-threats', providerId, limit, offset, type],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (type) params.set('type', type);
      const res = await api.get<ProviderThreat[]>(`/api/providers/${providerId}/threats?${params}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!providerId,
  });
}

// ─── Provider Timeline ────────────────────────────────────────

export function useProviderTimeline(providerId: string | null) {
  return useQuery({
    queryKey: ['provider-timeline', providerId],
    queryFn: async () => {
      const res = await api.get<TimelineData>(`/api/providers/${providerId}/timeline?period=30d`);
      return res.data ?? { labels: [], values: [] };
    },
    placeholderData: keepPreviousData,
    enabled: !!providerId,
  });
}

// ─── Provider Clusters ────────────────────────────────────────

export function useProviderClusters(providerId: string | null) {
  return useQuery({
    queryKey: ['provider-clusters', providerId],
    queryFn: async () => {
      const res = await api.get<Cluster[]>(`/api/providers/${providerId}/clusters`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!providerId,
  });
}

// ─── Dashboard provider trends (worst / improving) ──────────

export interface DashboardProvider {
  provider_id: string;
  name: string;
  asn: string | null;
  threat_count: number;
  recent?: number;
  previous?: number;
  trend_7d_pct: number | null;
}

export function useDashboardProviders(sort: 'worst' | 'improving', limit = 2) {
  return useQuery({
    queryKey: ['dashboard-providers', sort, limit],
    queryFn: async () => {
      const res = await api.get<DashboardProvider[]>(`/api/dashboard/providers?sort=${sort}&limit=${limit}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
  });
}
