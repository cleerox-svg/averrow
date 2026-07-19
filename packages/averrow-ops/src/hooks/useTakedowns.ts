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

export interface StatusCount {
  status: string;
  count: number;
}

export type TakedownScope = 'authorized' | 'prospect' | 'all';

export interface TakedownFilters {
  status?: string;
  severity?: string;
  target_type?: string;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  /** Purpose-scoped queue split (S2.3, T1). Default `authorized` server-side. */
  scope?: TakedownScope;
  /** Server-side equality filter on brand id. */
  brand_id?: string;
}

export function useAdminTakedowns(options?: TakedownFilters, queryOptions?: { enabled?: boolean }) {
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
      if (options?.scope) params.set('scope', options.scope);
      if (options?.brand_id) params.set('brand_id', options.brand_id);
      const qs = params.toString();
      const res = await api.get<{ data: Takedown[]; total: number; status_counts: StatusCount[]; scope: TakedownScope }>(
        `/api/admin/takedowns${qs ? `?${qs}` : ''}`
      );
      const body = res as unknown as { data: Takedown[]; total: number; status_counts: StatusCount[]; scope: TakedownScope };
      return {
        takedowns: body.data ?? [],
        total: body.total ?? 0,
        statusCounts: body.status_counts ?? [],
        scope: body.scope ?? options?.scope ?? 'authorized',
      };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    enabled: queryOptions?.enabled ?? true,
  });
}

// ─── Page-drained fetch for the Prospect rollup (S2.3 T2, F1) ──────────
// Prospect mode groups orgless drafts by brand into a single "everything
// we'd action for you" sales artifact — a single `limit`-capped page would
// silently drop brands past the cutoff and undercount straddling brands'
// draft/evidence totals. Prospect is a low-frequency internal view, so
// draining the full scoped set client-side (bounded by a safety cap) is an
// acceptable trade for correctness here; this is NOT a pattern to reuse for
// the high-frequency Authorized queue.

const DRAIN_PAGE_SIZE = 500;
// ~10k rows. If the scoped set is exactly a multiple of DRAIN_PAGE_SIZE,
// the last allowed page coming back full is treated as "there might be
// more" even on the rare exact-boundary case — an honest overcautious
// truncation flag beats a silent undercount.
const DRAIN_MAX_PAGES = 20;

export interface DrainedTakedowns {
  takedowns: Takedown[];
  total: number;
  statusCounts: StatusCount[];
  scope: TakedownScope;
  /** True if the safety cap was hit before the full scoped set was drained. */
  truncated: boolean;
}

export interface DrainFilters {
  scope: TakedownScope;
  brand_id?: string;
  enabled?: boolean;
}

export function useAdminTakedownsAll(options: DrainFilters) {
  const { scope, brand_id, enabled = true } = options;
  return useQuery({
    queryKey: ['admin-takedowns-all', scope, brand_id],
    queryFn: async (): Promise<DrainedTakedowns> => {
      const takedowns: Takedown[] = [];
      let total = 0;
      let statusCounts: StatusCount[] = [];
      let resolvedScope: TakedownScope = scope;
      let truncated = false;

      for (let page = 0; page < DRAIN_MAX_PAGES; page++) {
        const params = new URLSearchParams();
        params.set('scope', scope);
        if (brand_id) params.set('brand_id', brand_id);
        params.set('limit', String(DRAIN_PAGE_SIZE));
        params.set('offset', String(page * DRAIN_PAGE_SIZE));

        const res = await api.get<{ data: Takedown[]; total: number; status_counts: StatusCount[]; scope: TakedownScope }>(
          `/api/admin/takedowns?${params.toString()}`
        );
        const body = res as unknown as { data: Takedown[]; total: number; status_counts: StatusCount[]; scope: TakedownScope };
        const rows = body.data ?? [];
        takedowns.push(...rows);
        total = body.total ?? total;
        statusCounts = body.status_counts ?? statusCounts;
        resolvedScope = body.scope ?? resolvedScope;

        if (rows.length < DRAIN_PAGE_SIZE) {
          // Short page — fully drained.
          break;
        }
        if (page === DRAIN_MAX_PAGES - 1) {
          // Hit the safety cap with a still-full page — there's likely more
          // beyond it. Surface this honestly rather than truncating silently.
          truncated = true;
        }
      }

      return { takedowns, total, statusCounts, scope: resolvedScope, truncated };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    enabled,
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
