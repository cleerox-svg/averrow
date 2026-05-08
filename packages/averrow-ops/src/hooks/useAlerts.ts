import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Alert {
  id: string;
  brand_id: string;
  user_id: string;
  alert_type: string;
  severity: string;
  title: string;
  summary: string;
  details: string | null;
  source_type: string | null;
  source_id: string | null;
  ai_assessment: string | null;
  ai_recommendations: string | null;
  status: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  email_sent: number;
  webhook_sent: number;
  created_at: string;
  updated_at: string;
  brand_name: string | null;
  brand_domain: string | null;
  saas_technique_id: string | null;
  saas_technique_name: string | null;
  saas_technique_phase: string | null;
  saas_technique_phase_label: string | null;
  saas_technique_severity: string | null;
}

export interface AlertStats {
  total: number;
  new_count: number;
  acknowledged: number;
  resolved: number;
  dismissed: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  by_brand: {
    brand_id: string;
    brand_name: string | null;
    brand_domain: string | null;
    alert_count: number;
    new_count: number;
  }[];
}

export interface AlertFilters {
  status?: string;
  severity?: string;
  alert_type?: string;
  brand_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function useAlerts(filters?: AlertFilters) {
  return useQuery({
    queryKey: ['alerts', filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters?.status && filters.status !== 'all') params.set('status', filters.status);
      if (filters?.severity && filters.severity !== 'all') params.set('severity', filters.severity);
      if (filters?.alert_type && filters.alert_type !== 'all') params.set('alert_type', filters.alert_type);
      if (filters?.brand_id) params.set('brand_id', filters.brand_id);
      if (filters?.search) params.set('search', filters.search);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      const res = await api.get<Alert[]>(`/api/alerts${qs ? `?${qs}` : ''}`);
      return {
        alerts: (res.data ?? []) as Alert[],
        total: res.total ?? 0,
      };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function useAlertStats() {
  return useQuery({
    queryKey: ['alert-stats'],
    queryFn: async () => {
      const res = await api.get<AlertStats>('/api/alerts/stats');
      return (res.data ?? {}) as AlertStats;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 300_000,
  });
}

// Lightweight count for the bell-dropdown "X alerts need triage" row.
// Status='new' alerts only — fresh things to look at, not the full
// open workload (acknowledged + investigating). Cached server-side
// in KV for 60s; the client refetches every 60s too.
export interface AlertTriageSummary {
  new_count: number;
  critical_count: number;
}

export function useAlertTriageSummary() {
  return useQuery({
    queryKey: ['alert-triage-summary'],
    queryFn: async () => {
      const res = await api.get<AlertTriageSummary>('/api/alerts/triage-summary');
      return res.data ?? { new_count: 0, critical_count: 0 };
    },
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => {
      return api.patch(`/api/alerts/${id}`, { status, notes });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alert-stats'] });
    },
  });
}

export function useBulkAcknowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { alert_ids?: string[]; brand_id?: string }) => {
      return api.post('/api/alerts/bulk-acknowledge', params);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alert-stats'] });
    },
  });
}

export function useBulkTakedown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { alert_ids?: string[]; brand_id?: string }) => {
      return api.post('/api/alerts/bulk-takedown', params);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alert-stats'] });
      qc.invalidateQueries({ queryKey: ['admin-takedowns'] });
    },
  });
}
