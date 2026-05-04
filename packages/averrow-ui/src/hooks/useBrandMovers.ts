// Powers the "Brand Movers" section on the unified Home.
//
// Calls /api/brands/movers (Phase 3) which returns:
//   { rising:  [{...brand row, today_count, week_ago_count, delta_7d}],
//     falling: [...same shape, sorted by largest negative delta first] }
//
// Backend caches in KV for 5 min — daily-grain delta data has no need
// for tighter freshness. We poll once per hour client-side as a safety
// net for users who keep Home open across day boundaries.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BrandMover {
  id:                   string;
  name:                 string;
  canonical_domain:     string;
  logo_url:             string | null;
  email_security_grade: string | null;
  /** Pre-computed current threat count from the brands table. */
  threat_count:         number;
  /** Active threats on the most recent daily snapshot date. */
  today_count:          number;
  /** Active threats on (most recent snapshot date - 7 days). */
  week_ago_count:       number;
  /** today_count - week_ago_count. Positive = rising, negative = cooling. */
  delta_7d:             number;
}

export interface BrandMoversData {
  rising:  BrandMover[];
  falling: BrandMover[];
}

interface BrandMoversResponse {
  success: boolean;
  data?:   BrandMoversData;
  error?:  string;
}

export function useBrandMovers() {
  return useQuery({
    queryKey: ['brand-movers', 'v1'],
    queryFn: async (): Promise<BrandMoversData> => {
      const res = await api.get<BrandMoversResponse>('/api/brands/movers');
      return res.data ?? { rising: [], falling: [] };
    },
    staleTime: 5 * 60_000,    // 5 min — matches the worker KV TTL
    refetchInterval: 60 * 60_000, // refresh hourly for long-lived sessions
  });
}
