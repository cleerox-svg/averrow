// Multi-feed consensus — IPs reported by 4+ independent threat feeds.
// Backed by GET /api/intel/multi-feed-consensus (≤50 rows, 6h server cache).

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface MultiFeedConsensusRow {
  ip_address: string;
  feed_count: number;
  feeds: string[];
  threat_count: number;
  brand_count: number;
  last_seen: string | null;
}

export function useMultiFeedConsensus() {
  return useQuery({
    queryKey: ['multi-feed-consensus'],
    queryFn: async () => {
      const res = await api.get<MultiFeedConsensusRow[]>('/api/intel/multi-feed-consensus');
      if (!res.success) throw new Error(res.error ?? 'Failed');
      return Array.isArray(res.data) ? res.data : [];
    },
    staleTime: 5 * 60 * 1000,
  });
}
