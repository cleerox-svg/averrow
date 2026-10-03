// Shared inflow query for ThreatInflowChart (/threats) and the Home tempo band.
//
// One query key + endpoint (`/api/threats/inflow?window=…`, KV-cached on the
// worker) so Home and Threats share a single React Query cache entry. Kept out
// of ThreatInflowChart.tsx so importing it does not pull Recharts into Home.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type InflowWindow = '24h' | '7d';

export interface InflowResponse {
  window: InflowWindow;
  buckets: string[];
  series: Array<{ threat_type: string; counts: number[]; total: number }>;
  total: number;
  generated_at: string;
}

// Guard against the untyped `api.get` handing back a non-InflowResponse
// body — e.g. the platform's `{success:false,error}` error envelope on a
// 4xx or a 2xx-wrapped failure, which `api.ts` resolves (a first-attempt
// 5xx GET and any 401 reject with ApiError instead).
// Without this, a malformed response would blind-cast through and the
// `data.buckets.map(...)` consumers throw, crashing the whole root route via
// the ErrorBoundary. A malformed body is a failed load (query error), never
// "no data" / 0 indicators. Mirrors the isPlatformStatus guard in usePlatformStatus.
export function isInflowResponse(value: unknown): value is InflowResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { buckets?: unknown }).buckets) &&
    Array.isArray((value as { series?: unknown }).series)
  );
}

export function useThreatInflow(window: InflowWindow) {
  return useQuery({
    queryKey: ['threats', 'inflow', window],
    queryFn: async (): Promise<InflowResponse> => {
      const res = await api.get(`/api/threats/inflow?window=${window}`);
      if (!isInflowResponse(res)) throw new Error('Unexpected threat inflow response');
      return res;
    },
    refetchInterval: 5 * 60_000, // matches cube refresh cadence
    staleTime: 60_000,
  });
}
