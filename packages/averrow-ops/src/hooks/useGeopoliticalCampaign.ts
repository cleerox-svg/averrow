import { useQuery, useMutation, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────────

export interface GeopoliticalCampaign {
  id: string;
  name: string;
  conflict: string;
  status: string;
  threat_actors: string;
  adversary_countries: string;
  adversary_asns: string;
  target_countries: string;
  target_sectors: string;
  target_brands: string;
  ttps: string;
  escalation_rules: string;
  ioc_sources: string;
  known_iocs: string;
  start_date: string;
  end_date: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeoCampaignStats {
  total_threats: number;
  threats_24h: number;
  threats_7d: number;
  brands_targeted: number;
  unique_ips: number;
  unique_domains: number;
  critical_count: number;
  high_count: number;
}

export interface GeoCampaignThreat {
  id: string;
  threat_type: string;
  severity: string;
  status: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  ip_address: string | null;
  asn: string | null;
  country_code: string | null;
  hosting_provider_id: string | null;
  target_brand_id: string | null;
  brand_name: string | null;
  first_seen: string;
  last_seen: string;
  created_at: string;
}

export interface GeoCampaignTimeline {
  labels: string[];
  values: number[];
  by_type: {
    phishing: number[];
    credential_harvesting: number[];
    malware: number[];
    typosquatting: number[];
    impersonation: number[];
  };
}

export interface GeoCampaignBrand {
  id: string;
  name: string;
  sector: string | null;
  canonical_domain: string | null;
  threat_count: number;
  critical_count: number;
  high_count: number;
  first_targeted: string;
  last_targeted: string;
}

export interface GeoCampaignAsn {
  asn: string;
  provider_name: string;
  country_code: string | null;
  threat_count: number;
  unique_ips: number;
  unique_domains: number;
  first_seen: string;
  last_seen: string;
  is_known_adversary: boolean;
}

export interface GeoCampaignAttackType {
  threat_type: string;
  count: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

// ─── Hooks ──────────────────────────────────────────────────────

export function useGeopoliticalCampaigns(status?: string) {
  return useQuery({
    queryKey: ['geo-campaigns', status],
    queryFn: async () => {
      const params = status ? `?status=${status}` : '';
      const res = await api.get<GeopoliticalCampaign[]>(`/api/campaigns/geo${params}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
  });
}

export function useGeopoliticalCampaign(slug: string) {
  return useQuery({
    queryKey: ['geo-campaign', slug],
    queryFn: async () => {
      const res = await api.get<GeopoliticalCampaign>(`/api/campaigns/geo/${slug}`);
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    enabled: !!slug,
  });
}

export function useGeoCampaignStats(slug: string) {
  return useQuery({
    queryKey: ['geo-campaign-stats', slug],
    queryFn: async () => {
      const res = await api.get<GeoCampaignStats>(`/api/campaigns/geo/${slug}/stats`);
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    enabled: !!slug,
    refetchInterval: 60_000,
  });
}

export function useGeoCampaignThreats(slug: string, options?: { limit?: number; offset?: number }) {
  const { limit = 50, offset = 0 } = options ?? {};
  return useQuery({
    queryKey: ['geo-campaign-threats', slug, limit, offset],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const res = await api.get<{ threats: GeoCampaignThreat[]; total: number }>(`/api/campaigns/geo/${slug}/threats?${params}`);
      return res.data ?? { threats: [], total: 0 };
    },
    placeholderData: keepPreviousData,
    enabled: !!slug,
  });
}

export function useGeoCampaignTimeline(slug: string) {
  return useQuery({
    queryKey: ['geo-campaign-timeline', slug],
    queryFn: async () => {
      const res = await api.get<GeoCampaignTimeline>(`/api/campaigns/geo/${slug}/timeline`);
      return res.data ?? { labels: [], values: [], by_type: { phishing: [], credential_harvesting: [], malware: [], typosquatting: [], impersonation: [] } };
    },
    placeholderData: keepPreviousData,
    enabled: !!slug,
  });
}

export function useGeoCampaignBrands(slug: string) {
  return useQuery({
    queryKey: ['geo-campaign-brands', slug],
    queryFn: async () => {
      const res = await api.get<GeoCampaignBrand[]>(`/api/campaigns/geo/${slug}/brands`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!slug,
  });
}

export function useGeoCampaignAsns(slug: string) {
  return useQuery({
    queryKey: ['geo-campaign-asns', slug],
    queryFn: async () => {
      const res = await api.get<GeoCampaignAsn[]>(`/api/campaigns/geo/${slug}/asns`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!slug,
  });
}

export function useGeoCampaignAttackTypes(slug: string) {
  return useQuery({
    queryKey: ['geo-campaign-attack-types', slug],
    queryFn: async () => {
      const res = await api.get<GeoCampaignAttackType[]>(`/api/campaigns/geo/${slug}/attack-types`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!slug,
  });
}

export interface GeoCampaignAssessment {
  assessment: string;
  tokens_used: number;
  generated_at: string;
}

export function useGeoCampaignAssessment(slug: string) {
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<GeoCampaignAssessment>(`/api/campaigns/geo/${slug}/assessment`);
      if (!res.success || !res.data) {
        throw new Error(res.error ?? 'Assessment generation failed');
      }
      return res.data;
    },
  });
}
