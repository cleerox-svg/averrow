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
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_to_name: string | null;
  assigned_to_email: string | null;
  // Staff-only ownership + notes. `assigned_to*` above is the CUSTOMER's own
  // assignee (staff never write it); staff work uses these. Customers see the
  // staff side only as "Averrow SOC".
  staff_assigned_to: string | null;
  staff_assigned_at: string | null;
  staff_assigned_to_name: string | null;
  staff_assigned_to_email: string | null;
  staff_notes: string | null;
}

export interface AlertStats {
  total: number;
  new_count: number;
  acknowledged: number;
  resolved: number;
  dismissed: number;
  auto_dismissed: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Bulk endpoints process at most BULK_BATCH ids per call and report what is left. */
export const BULK_BATCH = 90;
export interface BulkAckResult { updated: number; alert_ids: string[]; remaining: number }
export interface BulkTakedownResult { takedowns_created: number; alerts_acknowledged: number; alert_ids: string[]; remaining: number }

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

// One alert by id, for `?alert=<id>` deep links whose alert is not in the
// loaded (filtered/limited) list. Key sits under ['alerts'] so every mutation's
// ['alerts'] invalidation refreshes it too.
export function useAlert(id: string | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['alerts', 'detail', id],
    queryFn: async () => {
      const res = await api.get<Alert>(`/api/alerts/${encodeURIComponent(id ?? '')}`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load alert');
      return res.data;
    },
    enabled: !!id && opts.enabled !== false,
    retry: false,
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
// Platform-wide, status='new' alerts only — fresh things to look at, not the full
// open workload (acknowledged + investigating). Cached server-side
// in KV for 60s; the client refetches every 60s too.
// Platform-wide (every staff role sees the same numbers). `top` is the single
// alert Home deep-links to ("Open alert"); null when nothing is awaiting triage.
export interface AlertTriageTop {
  id: string;
  title: string;
  severity: string;
  brand_id: string;
  brand_name: string | null;
  alert_type: string;
  created_at: string | null;
}

export interface AlertTriageSummary {
  new_count: number;
  critical_count: number;
  top?: AlertTriageTop | null;
}

export function useAlertTriageSummary(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['alert-triage-summary'],
    queryFn: async () => {
      const res = await api.get<AlertTriageSummary>('/api/alerts/triage-summary');
      // A JSON 4xx/5xx resolves as { success:false } — throw so the query
      // lands in its error path instead of reporting a fake "0 to triage".
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed to load alert triage summary');
      return res.data;
    },
    enabled: opts.enabled !== false,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: string; notes?: string | null }) => {
      return api.patch(`/api/alerts/${id}`, { status, notes });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alert-stats'] });
      qc.invalidateQueries({ queryKey: ['alert-triage-summary'] });
    },
  });
}

export function useAssignAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, staff_assigned_to }: { id: string; staff_assigned_to: string | null }) => {
      // Staff owner only: the worker 400s on `assigned_to` (customer-owned field).
      return api.patch(`/api/alerts/${id}`, { staff_assigned_to });
    },
    // Returned so the mutation only settles once the refetch has landed; the
    // page's optimistic overlay is cleared in onSettled and fresh data wins.
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['alerts'] }),
      qc.invalidateQueries({ queryKey: ['alert-stats'] }),
      qc.invalidateQueries({ queryKey: ['alert-triage-summary'] }),
    ]),
  });
}

export function useBulkAcknowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { alert_ids?: string[]; brand_id?: string }) => {
      return api.post<BulkAckResult>('/api/alerts/bulk-acknowledge', params);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alert-stats'] });
      qc.invalidateQueries({ queryKey: ['alert-triage-summary'] });
    },
  });
}

export function useBulkTakedown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { alert_ids?: string[]; brand_id?: string }) => {
      return api.post<BulkTakedownResult>('/api/alerts/bulk-takedown', params);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alert-stats'] });
      qc.invalidateQueries({ queryKey: ['alert-triage-summary'] });
      qc.invalidateQueries({ queryKey: ['admin-takedowns'] });
    },
  });
}
