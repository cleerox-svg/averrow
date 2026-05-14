// Domain Monitoring API client for averrow-tenant.
//
// Backed by:
//   GET /api/orgs/:orgId/modules/domain
//   GET /api/orgs/:orgId/modules/domain/brands/:brandId
//   POST /api/orgs/:orgId/takedowns                (typosquat request-takedown action)

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from './api';
import { useAuth } from './auth';

export interface DomainBrandSummary {
  brand_id:               string;
  brand_name:             string;
  canonical_domain:       string;
  lookalikes_total:       number;
  lookalikes_registered:  number;
  lookalikes_critical:    number;
  lookalikes_high:        number;
  lookalikes_taken_down:  number;
  certs_total:            number;
  certs_suspicious:       number;
  certs_new:              number;
  certs_malicious:        number;
}

export interface DomainModuleTotals {
  lookalikes_total:       number;
  lookalikes_registered:  number;
  lookalikes_critical:    number;
  lookalikes_high:        number;
  lookalikes_taken_down:  number;
  certs_total:            number;
  certs_suspicious:       number;
  certs_new:              number;
  certs_malicious:        number;
}

export interface DomainModuleSummary {
  org_id: number;
  brands: DomainBrandSummary[];
  totals: DomainModuleTotals;
}

export interface LookalikeRow {
  id:               string;
  brand_id:         string;
  domain:           string;
  permutation_type: string;
  registered:       number;
  resolves_to:      string | null;
  has_mx:           number;
  has_web:          number;
  first_seen:       string | null;
  last_checked:     string | null;
  threat_level:     string;
  ai_assessment:    string | null;
  status:           string;
  created_at:       string;
}

export interface CertRow {
  id:            string;
  brand_id:      string;
  domain:        string;
  issuer:        string | null;
  suspicious:    number;
  ai_assessment: string | null;
  status:        string;
  created_at:    string;
}

/**
 * Typosquatting threat row attributed to a brand. Sourced from the
 * `threats` table where threat_type='typosquatting' AND
 * target_brand_id matches. Distinct from `LookalikeRow` (the smaller
 * curated workspace in `lookalike_domains`) — typosquats here are
 * the production threat-intel rows the scanner emits at scale.
 */
export interface TyposquatRow {
  id:                  string;       // threats.id
  malicious_domain:    string;
  source_feed:         string;       // typosquat_scanner | ct_logs | numbered_variant_scan | nrd_hagezi
  severity:            string;       // critical | high | medium | low
  status:              string;       // active | resolved | etc
  first_seen:          string | null;
  last_seen:           string | null;
  hosting_provider:    string | null;
  country_code:        string | null;
  takedown_status:     string | null; // null = no takedown filed; else takedown_requests.status
  takedown_id:         string | null;
}

export interface BrandFindings {
  brand_id:   string;
  lookalikes: LookalikeRow[];
  certs:      CertRow[];
  typosquats: TyposquatRow[];
  page_size:  number;
}

export function useDomainModuleSummary() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<DomainModuleSummary>({
    queryKey: ['domain-module', orgId],
    queryFn: async () => {
      const res = await apiGet<DomainModuleSummary>(`/api/orgs/${orgId}/modules/domain`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useBrandDomainFindings(brandId: string | null) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<BrandFindings>({
    queryKey: ['domain-brand-findings', orgId, brandId],
    queryFn: async () => {
      const res = await apiGet<BrandFindings>(
        `/api/orgs/${orgId}/modules/domain/brands/${brandId}`,
      );
      return res.data;
    },
    enabled: !!orgId && !!brandId,
    staleTime: 30_000,
  });
}

/**
 * Request a takedown for a single typosquat threat.
 *
 * Wraps POST /api/orgs/:orgId/takedowns with `source_type='threat'` so
 * the backend pulls hosting-provider + abuse contact from the threat
 * row itself. Invalidates the brand findings query on success so the
 * row reflects its new takedown_status without a manual refresh.
 */
export interface RequestTakedownInput {
  brand_id:        string;
  threat_id:       string;
  malicious_domain:string;
  evidence_summary:string;
}

export function useRequestTakedown() {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RequestTakedownInput) => {
      if (!orgId) throw new Error('No organization');
      const res = await apiPost<{ id: string; status: string }>(
        `/api/orgs/${orgId}/takedowns`,
        {
          brand_id:         input.brand_id,
          target_type:      'domain',
          target_value:     input.malicious_domain,
          source_type:      'threat',
          source_id:        input.threat_id,
          evidence_summary: input.evidence_summary,
        },
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['domain-brand-findings', orgId, vars.brand_id] });
      qc.invalidateQueries({ queryKey: ['tenant-takedowns'] });
    },
  });
}
