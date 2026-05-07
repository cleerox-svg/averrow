// Social Media Impersonation API client.
//
// Backed by:
//   GET /api/orgs/:orgId/modules/social
//   GET /api/orgs/:orgId/modules/social/brands/:brandId

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface SocialBrandSummary {
  brand_id:               string;
  brand_name:             string;
  canonical_domain:       string;
  profiles_total:         number;
  profiles_official:      number;
  profiles_legitimate:    number;
  profiles_suspicious:    number;
  profiles_impersonation: number;
  profiles_parked:        number;
  profiles_high_critical: number;
}

export interface SocialModuleTotals {
  profiles_total:         number;
  profiles_official:      number;
  profiles_legitimate:    number;
  profiles_suspicious:    number;
  profiles_impersonation: number;
  profiles_parked:        number;
  profiles_high_critical: number;
}

export interface SocialModuleSummary {
  org_id: number;
  brands: SocialBrandSummary[];
  totals: SocialModuleTotals;
}

export interface SocialProfileRow {
  id:                       string;
  brand_id:                 string;
  platform:                 string;
  handle:                   string;
  profile_url:              string | null;
  display_name:             string | null;
  bio:                      string | null;
  avatar_url:               string | null;
  followers_count:          number | null;
  verified:                 number;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  impersonation_score:      number;
  impersonation_signals:    string | null;
  severity:                 string;
  status:                   string;
  created_at:               string;
}

export interface BrandSocialFindings {
  brand_id:  string;
  profiles:  SocialProfileRow[];
  page_size: number;
}

export function useSocialModuleSummary() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<SocialModuleSummary>({
    queryKey: ['social-module', orgId],
    queryFn: async () => {
      const res = await apiGet<SocialModuleSummary>(`/api/orgs/${orgId}/modules/social`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useBrandSocialFindings(brandId: string | null) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<BrandSocialFindings>({
    queryKey: ['social-brand-findings', orgId, brandId],
    queryFn: async () => {
      const res = await apiGet<BrandSocialFindings>(
        `/api/orgs/${orgId}/modules/social/brands/${brandId}`,
      );
      return res.data;
    },
    enabled: !!orgId && !!brandId,
    staleTime: 30_000,
  });
}
