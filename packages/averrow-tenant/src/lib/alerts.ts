// Tenant Alerts API client.
//
// Backed by GET /api/orgs/:orgId/alerts (handler:
// trust-radar/src/handlers/tenantData.ts:handleTenantAlerts).
// Org-scoped at handler level via org_brands ownership.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from './api';
import { useAuth } from './auth';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertStatus = 'new' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';

/** Analyst-driven status transitions accepted by
 *  PATCH /api/orgs/:orgId/alerts/:alertId (handler: tenantData.ts
 *  handleTenantUpdateAlert). 'new' is the system default and is NOT a
 *  valid transition target. */
export type AlertAction = 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';

export interface Alert {
  id:                  string;
  brand_id:            string;
  brand_name:          string;
  brand_domain:        string;
  user_id:             string;
  alert_type:          string;
  severity:            AlertSeverity;
  title:               string;
  summary:             string;
  details:             string | null;
  source_type:         string | null;
  source_id:           string | null;
  ai_assessment:       string | null;
  ai_recommendations:  string | null;
  status:              AlertStatus;
  acknowledged_at:     string | null;
  resolved_at:         string | null;
  resolution_notes:    string | null;
  created_at:          string;
}

export interface SeverityBreakdown {
  severity: AlertSeverity;
  count:    number;
}

export interface AlertsResponse {
  alerts:              Alert[];
  total:               number;
  severity_breakdown:  SeverityBreakdown[];
}

interface AlertsFilters {
  status?:   AlertStatus | 'all';
  severity?: AlertSeverity | 'all';
  brandId?:  string;
  limit?:    number;
}

export function useTenantAlerts(filters: AlertsFilters = {}) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;

  const params = new URLSearchParams();
  if (filters.status   && filters.status   !== 'all') params.set('status',   filters.status);
  if (filters.severity && filters.severity !== 'all') params.set('severity', filters.severity);
  if (filters.brandId)                                  params.set('brand_id', filters.brandId);
  params.set('limit', String(filters.limit ?? 50));

  return useQuery<AlertsResponse>({
    queryKey: ['tenant-alerts', orgId, params.toString()],
    queryFn: async () => {
      // Handler returns { success, data: Alert[], total, severity_breakdown }
      // — total + severity_breakdown live at the response ROOT, not inside
      // data. We pivot here to the AlertsResponse shape the page expects.
      const res = await apiGet<Alert[]>(`/api/orgs/${orgId}/alerts?${params}`) as unknown as {
        data:                Alert[];
        total:               number;
        severity_breakdown:  SeverityBreakdown[];
      };
      return {
        alerts:              res.data ?? [],
        total:               res.total ?? 0,
        severity_breakdown:  res.severity_breakdown ?? [],
      };
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

/** Org roles permitted to triage signals — mirrors the backend
 *  `canPerformHITL` gate (analyst+ in the viewer<analyst<admin<owner
 *  hierarchy). A global super_admin also qualifies. */
export function useCanTriage(): boolean {
  const { user } = useAuth();
  const orgRole = user?.organization?.role ?? '';
  return orgRole === 'analyst' || orgRole === 'admin' || orgRole === 'owner' || user?.role === 'super_admin';
}

/** Drive a signal's status lifecycle. Invalidates the signals list +
 *  dashboard rollups so counts and the queue update after a transition. */
export function useUpdateAlert() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ alertId, status, notes }: { alertId: string; status: AlertAction; notes?: string }) => {
      return apiPatch<{ message: string }>(
        `/api/orgs/${orgId}/alerts/${alertId}`,
        { status, ...(notes ? { notes } : {}) },
      );
    },
    onSuccess: () => {
      // Prefix-match invalidation covers every severity/status filter variant.
      qc.invalidateQueries({ queryKey: ['tenant-alerts', orgId] });
      qc.invalidateQueries({ queryKey: ['tenant-dashboard', orgId] });
    },
  });
}
