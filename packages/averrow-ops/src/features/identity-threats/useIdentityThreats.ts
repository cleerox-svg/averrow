// GET /api/intel/identity-threats?window=7d|30d — backend caches; we poll lazily.
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  IdentityDetectionDetail, IdentityDetectionList, IdentityFilters, IdentityThreatsData, IdentityWindow,
} from './types';

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

// ── Drill-down: filtered detections list (infinite) + lazy detail ──────────
export const DETECTIONS_PAGE_SIZE = 25;

export function useIdentityDetections(window: IdentityWindow, filters: IdentityFilters, opts: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: ['intel-identity-detections', window, filters.idp ?? '', filters.vector ?? '', filters.brand_id ?? '', filters.mitre ?? ''],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<IdentityDetectionList> => {
      const p = new URLSearchParams({ window, limit: String(DETECTIONS_PAGE_SIZE) });
      if (filters.idp) p.set('idp', filters.idp);
      if (filters.vector) p.set('vector', filters.vector);
      if (filters.brand_id) p.set('brand_id', filters.brand_id);
      if (filters.mitre) p.set('mitre', filters.mitre);
      if (pageParam) p.set('cursor', pageParam);
      const res = await api.get<IdentityDetectionList>(`/api/intel/identity-threats/detections?${p.toString()}`);
      if (res.success === false || !res.data) throw new Error(res.error ?? 'Failed to load detections');
      return res.data;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: opts.enabled !== false,
    staleTime: 60_000,
    retry: false,
  });
}

export function useIdentityDetection(threatId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['intel-identity-detection', threatId],
    queryFn: async (): Promise<IdentityDetectionDetail> => {
      const res = await api.get<IdentityDetectionDetail>(`/api/intel/identity-threats/detections/${encodeURIComponent(threatId)}`);
      if (res.success === false || !res.data) throw new Error(res.error ?? 'Failed to load detection');
      return res.data;
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
