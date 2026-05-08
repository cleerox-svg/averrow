import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Takedown {
  id: string;
  brand_id: string;
  brand_name?: string;
  brand_domain?: string;
  target_type: string;
  target_value: string;
  target_platform: string | null;
  target_url: string | null;
  evidence_summary: string;
  evidence_detail: string | null;
  evidence_urls: string | null;
  provider_name: string | null;
  provider_abuse_contact: string | null;
  provider_method: string | null;
  status: string;
  severity: string;
  priority_score: number;
  requested_by: string | null;
  source_type: string | null;
  notes: string | null;
  evidence_count?: number;
  created_at: string;
  submitted_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  updated_at: string;
}

export interface TakedownEvidence {
  id: string;
  takedown_id: string;
  evidence_type: string;
  title: string;
  content_text: string | null;
  storage_url: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface StatusCount {
  status: string;
  count: number;
}

export interface TakedownFilters {
  status?: string;
  severity?: string;
  target_type?: string;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export function useAdminTakedowns(options?: TakedownFilters) {
  return useQuery({
    queryKey: ['admin-takedowns', options],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.status) params.set('status', options.status);
      if (options?.severity) params.set('severity', options.severity);
      if (options?.target_type) params.set('target_type', options.target_type);
      if (options?.search) params.set('search', options.search);
      if (options?.sort) params.set('sort', options.sort);
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.offset) params.set('offset', String(options.offset));
      const qs = params.toString();
      const res = await api.get<{ data: Takedown[]; total: number; status_counts: StatusCount[] }>(
        `/api/admin/takedowns${qs ? `?${qs}` : ''}`
      );
      const body = res as unknown as { data: Takedown[]; total: number; status_counts: StatusCount[] };
      return {
        takedowns: body.data ?? [],
        total: body.total ?? 0,
        statusCounts: body.status_counts ?? [],
      };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function useTakedownEvidence(takedownId: string | null) {
  return useQuery({
    queryKey: ['takedown-evidence', takedownId],
    queryFn: async () => {
      const res = await api.get<TakedownEvidence[]>(`/api/admin/sparrow/evidence/${takedownId}`);
      return res.data || [];
    },
    placeholderData: keepPreviousData,
    enabled: !!takedownId,
  });
}

export function useUpdateTakedown() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status?: string; notes?: string }) => {
      const body: Record<string, string> = {};
      if (status) body.status = status;
      if (notes !== undefined) body.notes = notes as string;
      return api.patch(`/api/admin/takedowns/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-takedowns'] });
    },
  });
}
