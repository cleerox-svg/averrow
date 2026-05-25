// Tenant Threats API client — feeds the shared <ThreatsTable>.
//
// Backed by GET /api/orgs/:orgId/threats (handler handleTenantOrgThreats).
// Takes the shared ThreatsQueryParams (filter/sort/search/pagination) so
// the table behaves identically to the ops side; returns ThreatRow[] with
// the curated evidence columns the detail drawer renders.

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';
import type { ThreatRow, ThreatsQueryParams } from '@averrow/shared/threats-table';

export interface SeverityBreakdown { severity: string; count: number }
export interface TypeBreakdown { threat_type: string; count: number }

export interface ThreatsResponse {
  threats:             ThreatRow[];
  total:               number;
  severity_breakdown:  SeverityBreakdown[];
  type_breakdown:      TypeBreakdown[];
}

export function useTenantThreats(params: ThreatsQueryParams) {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;

  const qs = new URLSearchParams();
  if (params.status   && params.status   !== 'all') qs.set('status', params.status);
  if (params.severity)                              qs.set('severity', params.severity);
  if (params.type)                                  qs.set('threat_type', params.type);
  if (params.brandId)                               qs.set('brand_id', params.brandId);
  if (params.country)                               qs.set('country', params.country);
  if (params.q)                                     qs.set('q', params.q);
  qs.set('sort', params.sort);
  qs.set('dir', params.dir);
  qs.set('limit', String(params.limit));
  qs.set('offset', String(params.offset));

  return useQuery<ThreatsResponse>({
    queryKey: ['tenant-threats', orgId, qs.toString()],
    queryFn: async () => {
      const res = await apiGet<ThreatRow[]>(`/api/orgs/${orgId}/threats?${qs}`) as unknown as {
        data: ThreatRow[]; total: number;
        severity_breakdown: SeverityBreakdown[]; type_breakdown: TypeBreakdown[];
      };
      return {
        threats: res.data ?? [],
        total: res.total ?? 0,
        severity_breakdown: res.severity_breakdown ?? [],
        type_breakdown: res.type_breakdown ?? [],
      };
    },
    enabled: hasOrg && !!orgId,
    placeholderData: keepPreviousData,
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
