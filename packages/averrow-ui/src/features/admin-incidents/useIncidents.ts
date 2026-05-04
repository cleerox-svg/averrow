import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Mirrors lib/incidents.ts on the worker side. Kept inline (not hoisted to
// @averrow/shared) until a second consumer needs the same shape.
export type IncidentStatus =
  | 'investigating' | 'identified' | 'monitoring' | 'resolved' | 'postmortem';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type IncidentVisibility = 'internal' | 'public';

export type IncidentUpdateKind = 'operator' | 'system';

export interface Incident {
  id: string;
  title: string;
  description: string | null;
  public_title: string | null;
  public_details: string | null;
  status: IncidentStatus;
  severity: IncidentSeverity;
  visibility: IncidentVisibility;
  affected_components: string[];
  detected_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  created_by: string | null;
  lead_user_id: string | null;
  source: string;
  source_notification_id: string | null;
  source_group_key: string | null;
  root_cause: string | null;
  mitigation: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  kind: IncidentUpdateKind;
  status: IncidentStatus | null;
  message: string;
  /** Sanitized customer-safe copy. Required for the row to surface
   *  on /status even if visibility='public'. (Migration 0133.) */
  public_message: string | null;
  visibility: IncidentVisibility;
  event_ref: string | null;
  event_type: string | null;
  created_at: string;
  created_by: string | null;
  /** True for telemetry events synthesised at read time
   *  (not stored in incident_updates). Renders with a distinct
   *  glyph so operators can tell editorial vs raw signal apart. */
  synthetic?: boolean;
}

export function useIncidents(opts: { onlyOpen?: boolean } = {}) {
  return useQuery({
    queryKey: ['incidents', 'list', opts.onlyOpen ? 'open' : 'all'],
    queryFn: async (): Promise<Incident[]> => {
      const qs = opts.onlyOpen ? '?status=open' : '';
      const res = await api.get<Incident[]>(`/api/admin/incidents${qs}`);
      return res.data ?? [];
    },
    refetchInterval: 30_000,
  });
}

export function useIncident(id: string | undefined) {
  return useQuery({
    queryKey: ['incidents', 'detail', id],
    queryFn: async () => {
      if (!id) return null;
      const res = await api.get<{
        incident: Incident;
        updates: IncidentUpdate[];
        telemetry_count?: number;
      }>(`/api/admin/incidents/${id}`);
      return res.data ?? null;
    },
    enabled: !!id,
    refetchInterval: 30_000,
  });
}

export function useAppendIncidentUpdate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      message: string;
      /** Sanitized customer-safe copy. Required when visibility='public'
       *  — backend returns 400 otherwise. */
      public_message?: string;
      status?: IncidentStatus;
      visibility?: IncidentVisibility;
    }) => {
      await api.post(`/api/admin/incidents/${id}/updates`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function useTransitionIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (status: IncidentStatus) => {
      await api.post(`/api/admin/incidents/${id}/transition`, { status });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}

export function usePromoteIncident(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      visibility?: IncidentVisibility;
      public_title?: string | null;
      public_details?: string | null;
    }) => {
      await api.post(`/api/admin/incidents/${id}/promote`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
}
