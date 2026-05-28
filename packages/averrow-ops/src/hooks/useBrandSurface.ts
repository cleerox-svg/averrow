// Brand Surface tab data — owned-domain footprint + firmographic
// block. Backed by /api/brands/:id/domains + /api/brands/:id/firmographics
// endpoints added in PR7.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BrandDomain {
  id:           string;
  domain:       string;
  domain_type:  'apex' | 'subdomain' | 'redirect' | 'regional' | 'acquired_property' | 'customer_added';
  source:       string;
  verified:     number;        // 0 | 1
  first_seen:   string;
  last_seen:    string;
}

export interface BrandFirmographics {
  brand_id:        string;
  revenue_band:    string | null;
  employee_band:   string | null;
  industry_naics:  string | null;
  industry_sic:    string | null;
  founded_year:    number | null;
  is_public:       number | null;       // 0 | 1 | null
  ticker:          string | null;
  parent_company:  string | null;
  source:          string;
  source_url:      string | null;
  confidence:      number;
  enriched_at:     string;
  updated_at:      string;
}

export function useBrandDomains(brandId: string) {
  return useQuery({
    queryKey: ['brand-domains', brandId],
    queryFn: async () => {
      const res = await api.get<BrandDomain[]>(`/api/brands/${brandId}/domains`);
      return (res.data ?? []) as BrandDomain[];
    },
    enabled: !!brandId,
    staleTime: 60_000,
  });
}

export interface BrandScoreSnapshot {
  snapshot_day:          string;        // YYYY-MM-DD
  brand_health_score:    number | null;
  brand_exposure_score:  number | null;
  brand_health_grade:    string | null;
}

export function useBrandScoreHistory(brandId: string, days: number = 30) {
  return useQuery({
    queryKey: ['brand-score-history', brandId, days],
    queryFn: async () => {
      const res = await api.get<BrandScoreSnapshot[]>(
        `/api/brands/${brandId}/score-history?days=${days}`,
      );
      return (res.data ?? []) as BrandScoreSnapshot[];
    },
    enabled: !!brandId,
    staleTime: 5 * 60_000,
  });
}

export function useBrandFirmographics(brandId: string) {
  return useQuery({
    queryKey: ['brand-firmographics', brandId],
    queryFn: async () => {
      const res = await api.get<BrandFirmographics | null>(`/api/brands/${brandId}/firmographics`);
      return (res.data ?? null) as BrandFirmographics | null;
    },
    enabled: !!brandId,
    staleTime: 5 * 60_000,
  });
}

// Narrator agent output. ~55 rows in production at audit time; the
// /api/narratives/:brandId endpoint has been live but had no UI
// consumer until WS-A #3 — see AUDIT_dark_data.md.
export interface BrandNarrative {
  id:           string;
  brand_id:     string;
  title:        string;
  summary:      string;
  signal_types: string[];
  severity:     string;           // 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
  confidence:   number | null;
  attack_stage: string | null;
  status:       string;           // 'active' | 'archived' | ...
  generated_by: string | null;
  created_at:   string;
  updated_at:   string;
}

export function useBrandNarratives(brandId: string, limit: number = 5) {
  return useQuery({
    queryKey: ['brand-narratives', brandId, limit],
    queryFn: async () => {
      const res = await api.get<BrandNarrative[]>(
        `/api/narratives/${brandId}?status=active&limit=${limit}`,
      );
      return (res.data ?? []) as BrandNarrative[];
    },
    enabled: !!brandId,
    staleTime: 5 * 60_000,
  });
}

export interface EmailSecurityHistoryPoint {
  scanned_at:        string;
  spf_exists:        boolean;
  dkim_exists:       boolean;
  dmarc_exists:      boolean;
  dmarc_policy:      string | null;
  mx_exists:         boolean;
  protocols_passing: number;     // 0–4
}

export function useEmailSecurityHistory(brandId: string, limit: number = 30) {
  return useQuery({
    queryKey: ['brand-email-security-history', brandId, limit],
    queryFn: async () => {
      const res = await api.get<EmailSecurityHistoryPoint[]>(
        `/api/email-security/${brandId}/history?limit=${limit}`,
      );
      return (res.data ?? []) as EmailSecurityHistoryPoint[];
    },
    enabled: !!brandId,
    staleTime: 5 * 60_000,
  });
}
