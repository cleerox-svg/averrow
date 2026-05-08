import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────

export interface Operation {
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
  threat_history?: number[];
}

export interface OperationsStats {
  active_operations: number;
  accelerating: number;
  total_clusters: number;
  campaigns_tracked: number;
  brands_targeted: number;
  threat_types: number;
}

export interface TimelineData {
  labels: string[];
  values: number[];
}

// ─── Operations (infrastructure_clusters) ─────────────────────

export function useOperations(options?: { status?: string; limit?: number; offset?: number }) {
  const { status, limit = 50, offset = 0 } = options || {};
  return useQuery({
    queryKey: ['operations', status, limit, offset],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (status) params.set('status', status);
      const res = await api.get<Operation[]>(`/api/v1/operations?${params}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
  });
}

export function useOperationsStats() {
  return useQuery({
    queryKey: ['operations-stats'],
    queryFn: async () => {
      const res = await api.get<OperationsStats>('/api/v1/operations/stats');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
  });
}

export function useOperationTimeline(operationId: string | null) {
  return useQuery({
    queryKey: ['operation-timeline', operationId],
    queryFn: async () => {
      const res = await api.get<TimelineData>(`/api/v1/operations/${operationId}/timeline`);
      return res.data ?? { labels: [], values: [] };
    },
    placeholderData: keepPreviousData,
    enabled: !!operationId,
  });
}

export function useOperationThreats(operationId: string | null, options?: { limit?: number }) {
  const { limit = 10 } = options || {};
  return useQuery({
    queryKey: ['operation-threats', operationId, limit],
    queryFn: async () => {
      const res = await api.get<Array<Record<string, unknown>>>(`/api/v1/operations/${operationId}/threats?limit=${limit}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!operationId,
  });
}
