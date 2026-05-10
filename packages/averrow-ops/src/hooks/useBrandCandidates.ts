// Brand candidates queue — CT-driven proposed brands for operator review.
// Backed by the endpoints added in PR5 (lib/brand-candidates.ts).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BrandCandidate {
  id:                 string;
  apex_domain:        string;
  source:             'ct_log' | 'threat_target' | 'manual';
  status:             'pending' | 'promoted' | 'rejected' | 'duplicate';
  cert_count:         number;
  distinct_issuers:   number;
  first_seen:         string;
  last_seen:          string;
  reviewed_at:        string | null;
  reviewed_by:        string | null;
  promoted_brand_id:  string | null;
  notes:              string | null;
}

export function useBrandCandidates(status: 'pending' | 'promoted' | 'rejected' = 'pending') {
  return useQuery({
    queryKey: ['brand-candidates', status],
    queryFn: async () => {
      const res = await api.get<BrandCandidate[]>(
        `/api/admin/brand-candidates?status=${status}&limit=100`,
      );
      return {
        candidates: (res.data ?? []) as BrandCandidate[],
        total: res.total ?? 0,
      };
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function usePromoteBrandCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      api.post(`/api/admin/brand-candidates/${id}/promote`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brand-candidates'] });
      qc.invalidateQueries({ queryKey: ['brands'] });
    },
  });
}

export function useRejectBrandCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes?: string }) =>
      api.post(`/api/admin/brand-candidates/${id}/reject`, { notes }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brand-candidates'] });
    },
  });
}
