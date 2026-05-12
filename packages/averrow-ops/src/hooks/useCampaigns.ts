import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface Campaign {
  id: string;
  name: string;
  first_seen: string;
  last_seen: string;
  threat_count: number;
  brand_count: number;
  provider_count: number;
  domain_count: number;
  attack_pattern: string | null;
  status: string;
  severity: string | null;
}

interface CampaignStats {
  total: number;
  active_count: number;
  dormant_count: number;
  disrupted_count: number;
  active_threats: number;
  brands_affected: number;
}

interface CampaignDetail extends Campaign {
  ip_count: number;
  brand_breakdown: Array<{ brand_id: string | null; brand_name: string | null; count: number }>;
  provider_breakdown: Array<{ provider_id: string | null; provider_name: string | null; count: number }>;
}

export function useCampaigns(options?: { status?: string; limit?: number; offset?: number }) {
  const { status = 'active', limit = 50, offset = 0 } = options || {};
  return useQuery({
    queryKey: ['campaigns', status, limit, offset],
    queryFn: async () => {
      const params = new URLSearchParams({ status, limit: String(limit), offset: String(offset) });
      const res = await api.get<Campaign[]>(`/api/campaigns?${params}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
  });
}

export function useCampaignStats() {
  return useQuery({
    queryKey: ['campaign-stats'],
    queryFn: async () => {
      const res = await api.get<CampaignStats>('/api/campaigns/stats');
      return res.data || null;
    },
    placeholderData: keepPreviousData,
  });
}

export function useCampaignDetail(campaignId: string) {
  return useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: async () => {
      const res = await api.get<CampaignDetail>(`/api/campaigns/${campaignId}`);
      return res.data || null;
    },
    placeholderData: keepPreviousData,
    enabled: !!campaignId,
  });
}

interface CampaignTimelineData {
  labels: string[];
  values: number[];
}

export function useCampaignTimeline(campaignId: string, period: '24h' | '7d' | '30d' | '90d' = '30d') {
  return useQuery({
    queryKey: ['campaign-timeline', campaignId, period],
    queryFn: async () => {
      const res = await api.get<CampaignTimelineData>(`/api/campaigns/${campaignId}/timeline?period=${period}`);
      return res.data ?? { labels: [], values: [] };
    },
    placeholderData: keepPreviousData,
    enabled: !!campaignId,
  });
}

export interface CampaignThreatRow {
  id: string;
  threat_type: string;
  severity: string;
  status: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  ip_address: string | null;
  country_code: string | null;
  hosting_provider_id: string | null;
  target_brand_id: string | null;
  brand_name: string | null;
  first_seen: string;
  last_seen: string;
  created_at: string;
}

export function useCampaignThreats(campaignId: string, limit = 50) {
  return useQuery({
    queryKey: ['campaign-threats', campaignId, limit],
    queryFn: async () => {
      const res = await api.get<CampaignThreatRow[]>(
        `/api/campaigns/${campaignId}/threats?limit=${limit}`,
      );
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!campaignId,
  });
}

export interface CampaignInfrastructure {
  domains: Array<{ domain: string; ip_address: string | null; hosting_provider_id: string | null }>;
  ips: Array<{
    ip_address: string;
    domain_count: number;
    hosting_provider_id: string | null;
    country_code: string | null;
  }>;
  providers: Array<{ provider_id: string; provider_name: string; threat_count: number }>;
}

export function useCampaignInfrastructure(campaignId: string) {
  return useQuery({
    queryKey: ['campaign-infrastructure', campaignId],
    queryFn: async () => {
      const res = await api.get<CampaignInfrastructure>(`/api/campaigns/${campaignId}/infrastructure`);
      return res.data ?? { domains: [], ips: [], providers: [] };
    },
    placeholderData: keepPreviousData,
    enabled: !!campaignId,
  });
}

export interface CampaignBrandRow {
  id: string;
  name: string;
  sector: string | null;
  threat_count: number;
}

export function useCampaignBrands(campaignId: string) {
  return useQuery({
    queryKey: ['campaign-brands', campaignId],
    queryFn: async () => {
      const res = await api.get<CampaignBrandRow[]>(`/api/campaigns/${campaignId}/brands`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!campaignId,
  });
}
