import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface LookalikeDomain {
  id: string;
  brand_id: string;
  domain: string;
  registered: number;
  threat_level: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' | 'CRITICAL' | null;
  status: string | null;
  ip_address: string | null;
  registrar: string | null;
  bimi_record: string | null;
  created_at: string;
  updated_at: string;
}

export interface LookalikesParams {
  registered?: 0 | 1;
  threat_level?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export function useLookalikes(brandId: string, params: LookalikesParams = {}) {
  const qs = new URLSearchParams();
  if (params.registered !== undefined) qs.set('registered', String(params.registered));
  if (params.threat_level) qs.set('threat_level', params.threat_level);
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['lookalikes', brandId, params],
    queryFn: async () => {
      const res = await api.get<LookalikeDomain[]>(
        `/api/lookalikes/${brandId}${query ? `?${query}` : ''}`,
      );
      return {
        data: (res.data || []) as LookalikeDomain[],
        total: res.total ?? 0,
      };
    },
    placeholderData: keepPreviousData,
    enabled: !!brandId,
  });
}

export function useScanLookalikes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (brandId: string) =>
      api.post(`/api/lookalikes/${brandId}/scan`),
    onSuccess: (_, brandId) => {
      qc.invalidateQueries({ queryKey: ['lookalikes', brandId] });
    },
  });
}
