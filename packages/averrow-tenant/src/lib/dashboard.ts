// Tenant dashboard API client.
//
// Backed by GET /api/orgs/:orgId/dashboard
// (handler: averrow-worker/src/handlers/tenantData.ts:handleTenantDashboard).
//
// Returns the cross-brand overview: headline stats, per-brand
// active-threat rollup, 7-day threat trend, and recent alerts.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface DashboardBrand {
  id:                    string;
  name:                  string;
  canonical_domain:      string;
  sector:                string | null;
  threat_count:          number;
  exposure_score:        number | null;
  email_security_grade:  string | null;
  social_risk_score:     number | null;
  last_social_scan:      string | null;
  last_threat_seen:      string | null;
  is_primary:            number;
  active_threats:        number;
  social_profiles_count: number;
  impersonation_count:   number;
}

export interface DashboardRecentAlert {
  id:         string;
  title:      string;
  severity:   string;
  alert_type: string;
  status:     string;
  created_at: string;
  brand_name: string;
}

export interface DashboardTrendPoint {
  date:  string;
  count: number;
}

export interface DashboardResponse {
  total_brands:               number;
  total_active_threats:       number;
  total_alerts_open:          number;
  total_social_profiles:      number;
  total_impersonation_alerts: number;
  avg_exposure_score:         number | null;
  brands:                     DashboardBrand[];
  recent_alerts:              DashboardRecentAlert[];
  threat_trend:               DashboardTrendPoint[];
}

export function useTenantDashboard() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<DashboardResponse>({
    queryKey: ['tenant-dashboard', orgId],
    queryFn: async () => {
      const res = await apiGet<DashboardResponse>(`/api/orgs/${orgId}/dashboard`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 60_000,
  });
}
