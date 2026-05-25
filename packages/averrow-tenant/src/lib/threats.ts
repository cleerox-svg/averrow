// Tenant Threats API client.
//
// Backed by GET /api/orgs/:orgId/threats (handler:
// trust-radar/src/handlers/tenantData.ts:handleTenantOrgThreats).
// Org-scoped at the handler level via org_brands ownership.
//
// This is the records view behind the dashboard's per-brand threat
// counts: it lists individual threat rows from the production `threats`
// table across every brand the org owns, with brand / status / severity
// / type filters and pagination. Defaults to status='active'.

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export type ThreatSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ThreatStatus = 'active' | 'down' | 'remediated';
export type ThreatType =
  | 'phishing'
  | 'typosquatting'
  | 'impersonation'
  | 'malware_distribution'
  | 'credential_harvesting'
  | 'c2';

export interface Threat {
  id:               string;
  threat_type:      string;
  malicious_domain: string | null;
  malicious_url:    string | null;
  target_brand_id:  string;
  source_feed:      string;
  severity:         ThreatSeverity;
  status:           ThreatStatus;
  confidence_score: number | null;
  country_code:     string | null;
  ip_address:       string | null;
  first_seen:       string | null;
  last_seen:        string | null;
  brand_name:       string;
  brand_domain:     string;
}

export interface SeverityBreakdown {
  severity: ThreatSeverity;
  count:    number;
}

export interface TypeBreakdown {
  threat_type: string;
  count:       number;
}

export interface ThreatsResponse {
  threats:             Threat[];
  total:               number;
  severity_breakdown:  SeverityBreakdown[];
  type_breakdown:      TypeBreakdown[];
}

export interface ThreatsFilters {
  status?:     ThreatStatus | 'all';
  severity?:   ThreatSeverity | 'all';
  threatType?: ThreatType | 'all';
  brandId?:    string;
  q?:          string;
  limit?:      number;
  offset?:     number;
}

export function useTenantThreats(filters: ThreatsFilters = {}) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;

  const params = new URLSearchParams();
  if (filters.status     && filters.status     !== 'all') params.set('status', filters.status);
  if (filters.severity   && filters.severity   !== 'all') params.set('severity', filters.severity);
  if (filters.threatType && filters.threatType !== 'all') params.set('threat_type', filters.threatType);
  if (filters.brandId)                                    params.set('brand_id', filters.brandId);
  if (filters.q)                                          params.set('q', filters.q);
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));

  return useQuery<ThreatsResponse>({
    queryKey: ['tenant-threats', orgId, params.toString()],
    queryFn: async () => {
      // Handler returns { success, data: Threat[], total, severity_breakdown,
      // type_breakdown } — total + breakdowns live at the response ROOT, not
      // inside data. We pivot to the ThreatsResponse shape the page expects.
      const res = await apiGet<Threat[]>(`/api/orgs/${orgId}/threats?${params}`) as unknown as {
        data:                Threat[];
        total:               number;
        severity_breakdown:  SeverityBreakdown[];
        type_breakdown:      TypeBreakdown[];
      };
      return {
        threats:             res.data ?? [],
        total:               res.total ?? 0,
        severity_breakdown:  res.severity_breakdown ?? [],
        type_breakdown:      res.type_breakdown ?? [],
      };
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export const THREAT_TYPE_LABELS: Record<string, string> = {
  phishing:              'Phishing',
  typosquatting:         'Typosquatting',
  impersonation:         'Impersonation',
  malware_distribution:  'Malware',
  credential_harvesting: 'Credential harvesting',
  c2:                    'C2',
};
