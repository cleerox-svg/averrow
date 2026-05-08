// Tenant Alerts API client.
//
// Backed by GET /api/orgs/:orgId/alerts (handler:
// trust-radar/src/handlers/tenantData.ts:handleTenantAlerts).
// Org-scoped at handler level via org_brands ownership.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type AlertStatus = 'new' | 'acknowledged' | 'investigating' | 'resolved' | 'false_positive';

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
