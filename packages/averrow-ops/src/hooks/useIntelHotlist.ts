// Intel Hotlist — surfaces three classes of high-signal intel that
// already exist in the threats table but weren't reaching the UI
// before the 2026-05-16 platform audit (PR-A):
//
//   1. top_fanout_ips      — mass-impersonation infrastructure
//   2. multi_feed_consensus — IPs flagged by ≥4 independent feeds
//   3. recent_bursts        — domain swarms targeting one brand
//                             in a tight time window

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface FanoutIp {
  ip_address: string;
  brand_count: number;
  threat_count: number;
  last_seen: string;
}

export interface ConsensusIp {
  ip_address: string;
  feed_count: number;
  threat_count: number;
  feeds: string;
  last_seen: string;
}

export interface Burst {
  brand_id: string;
  brand_name: string;
  /** Brand favicon source — populated from brands.canonical_domain
   *  + brands.logo_url so the UI can render the same favicon
   *  treatment as BrandMovers. Null when the brand record has
   *  neither field set. */
  brand_domain: string | null;
  brand_logo_url: string | null;
  hour_bucket: string;
  threat_count: number;
  distinct_domains: number;
  burst_start: string;
  burst_end: string;
}

export interface IntelHotlistData {
  top_fanout_ips: FanoutIp[];
  multi_feed_consensus: ConsensusIp[];
  recent_bursts: Burst[];
  generated_at: string;
}

export function useIntelHotlist(limit = 10) {
  return useQuery({
    queryKey: ['intel-hotlist', limit],
    queryFn: async () => {
      const res = await api.get<IntelHotlistData>(`/api/intel/hotlist?limit=${limit}`);
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    // Backend caches 5min; client poll every 2min keeps the Home
    // tile feeling live without amplifying backend load.
    refetchInterval: 120_000,
  });
}
