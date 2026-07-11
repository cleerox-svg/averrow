import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ThreatActor {
  id: string;
  name: string;
  aliases: string | null;
  attribution: string | null;
  country: string | null;
  capability: string | null;
  description: string | null;
  ttps: string | null;
  target_sectors: string | null;
  active_campaigns: string | null;
  first_seen: string | null;
  last_seen: string | null;
  status: string;
  attribution_confidence?: string;
  infra_count?: number;
  target_count?: number;
  /** Total attributions linking this actor to threats (lifetime). Populated
   *  by OTX pulses + Attributor agent + manual entries via threat_attributions. */
  attribution_count_total?: number;
  /** Attributions observed in the last 7 days — current activity signal. */
  attribution_count_7d?: number;
  /** 14-day daily threat count from actor's known ASN infrastructure (oldest first) */
  threat_history?: number[];
  created_at: string;
  updated_at: string;
}

interface ThreatActorStats {
  total: number;
  active: number;
  by_country: Array<{ country: string; count: number }>;
  by_attribution: Array<{ attribution: string; count: number }>;
  tracked_infrastructure: number;
  targeted_brands: number;
}

export interface RecentAttribution {
  id: string;
  threat_id: string;
  source: 'otx' | 'nexus' | 'manual' | 'news';
  source_pulse_name: string | null;
  confidence: 'confirmed' | 'high' | 'medium' | 'low';
  actor_name_raw: string | null;
  observed_at: string;
}

export interface NewsMention {
  id: string;
  source_feed: string;
  article_url: string;
  title: string;
  excerpt: string | null;
  published_at: string | null;
  ingested_at: string;
  is_geopolitical: number;
}

interface ThreatActorDetail extends ThreatActor {
  infrastructure: Array<{
    id: string;
    asn: string | null;
    ip_range: string | null;
    domain: string | null;
    country_code: string | null;
    confidence: string;
    notes: string | null;
  }>;
  targets: Array<{
    id: string;
    brand_id: string | null;
    brand_name: string | null;
    canonical_domain: string | null;
    sector: string | null;
    context: string | null;
  }>;
  linked_threat_count: number;
  recent_attributions: RecentAttribution[];
  news_mentions: NewsMention[];
}

export function useThreatActors(options?: { country?: string; status?: string; affiliation?: string; search?: string }) {
  const { country, status, affiliation, search } = options || {};
  return useQuery({
    queryKey: ['threat-actors', country, status, affiliation, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (country) params.set('country', country);
      if (status) params.set('status', status);
      if (affiliation) params.set('affiliation', affiliation);
      // handleListThreatActors matches name/aliases/description — lets
      // ThreatActors.tsx filter on arrival for a ?q= deep-link.
      if (search) params.set('q', search);
      const qs = params.toString();
      const res = await api.get<ThreatActor[]>(`/api/threat-actors${qs ? `?${qs}` : ''}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
  });
}

export function useThreatActorStats() {
  return useQuery({
    queryKey: ['threat-actor-stats'],
    queryFn: async () => {
      const res = await api.get<ThreatActorStats>('/api/threat-actors/stats');
      return res.data || null;
    },
    placeholderData: keepPreviousData,
  });
}

export function useThreatActorDetail(id: string) {
  return useQuery({
    queryKey: ['threat-actor', id],
    queryFn: async () => {
      const res = await api.get<ThreatActorDetail>(`/api/threat-actors/${id}`);
      return res.data || null;
    },
    placeholderData: keepPreviousData,
    enabled: !!id,
  });
}

export function useThreatActorsByBrand(brandId: string) {
  return useQuery({
    queryKey: ['threat-actors-by-brand', brandId],
    queryFn: async () => {
      const res = await api.get<ThreatActor[]>(`/api/threat-actors/by-brand/${brandId}`);
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    enabled: !!brandId,
  });
}
