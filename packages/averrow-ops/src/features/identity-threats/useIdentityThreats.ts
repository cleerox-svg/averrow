// GET /api/intel/identity-threats?window=7d|30d — backend caches; we poll lazily.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { IdentityThreatsData, IdentityWindow } from './types';

export function useIdentityThreats(window: IdentityWindow, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['intel-identity-threats', window],
    queryFn: async (): Promise<IdentityThreatsData> => {
      const res = await api.get<IdentityThreatsData>(`/api/intel/identity-threats?window=${window}`);
      // A failure envelope must reach the error path, never read as "no detections".
      if (res.success === false || !res.data) {
        throw new Error(res.error ?? 'Failed to load identity threats');
      }
      return res.data;
    },
    enabled: opts.enabled !== false,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
