// Powers the "Provider Movers" section on the unified Home — the
// hosting-provider counterpart to useBrandMovers. Calls
// /api/providers/movers (Phase 6) which mirrors /api/brands/movers:
// daily_snapshots-driven 7d active-threats delta, split into rising
// (positive delta) and falling (negative delta) buckets.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ProviderMover {
  id:                  string;
  name:                string;
  asn:                 string | null;
  country:             string | null;
  reputation_score:    number | null;
  /** Pre-computed current active threat count from hosting_providers. */
  active_threat_count: number;
  today_count:         number;
  week_ago_count:      number;
  delta_7d:            number;
}

export interface ProviderMoversData {
  rising:  ProviderMover[];
  falling: ProviderMover[];
}

interface ProviderMoversResponse {
  success: boolean;
  data?:   ProviderMoversData;
  error?:  string;
}

export function useProviderMovers() {
  return useQuery({
    queryKey: ['provider-movers', 'v1'],
    queryFn: async (): Promise<ProviderMoversData> => {
      const res = await api.get<ProviderMoversResponse>('/api/providers/movers');
      return res.data ?? { rising: [], falling: [] };
    },
    staleTime: 5 * 60_000,
    refetchInterval: 60 * 60_000,
  });
}
