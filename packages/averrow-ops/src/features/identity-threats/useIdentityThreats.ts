// GET /api/intel/identity-threats?window=7d|30d — backend caches; we poll lazily.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  IdentityDetectionDetail, IdentityDetectionList, IdentityFilters, IdentityThreatsData, IdentityWindow, PageCapture,
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
    // Poll only while a capture is in flight; stops once all are settled
    // (and when the panel unmounts, which also disables the query).
    refetchInterval: (query) => (hasPendingCapture(query.state.data?.captures) ? CAPTURE_POLL_MS : false),
    retry: false,
  });
}

// ── Page capture ───────────────────────────────────────────────────────────
export const CAPTURE_POLL_MS = 20_000;

export function hasPendingCapture(captures: PageCapture[] | undefined): boolean {
  return !!captures?.some((c) => c.status === 'queued' || c.status === 'capturing');
}

export class CaptureError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CaptureError';
    this.status = status;
  }
}

export function useCaptureNow(threatId: string) {
  const qc = useQueryClient();
  const key = ['intel-identity-detection', threatId];
  return useMutation({
    mutationFn: async (): Promise<{ id: string; status: string }> => {
      const res = await api.post<{ id: string; status: string }>(
        `/api/intel/identity-threats/detections/${encodeURIComponent(threatId)}/capture`,
      );
      if (res.success === false || !res.data) {
        if (res.status === 409) throw new CaptureError('A capture is already in progress', 409);
        if (res.status === 403) throw new CaptureError("You don't have permission to capture pages", 403);
        throw new CaptureError(res.error ?? "Couldn't queue the capture", res.status);
      }
      return res.data;
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<IdentityDetectionDetail>(key);
      if (prev) {
        const optimistic: PageCapture = {
          id: 'optimistic', status: 'queued', queued_at: new Date().toISOString(), captured_at: null, expires_at: null,
          final_url: null, http_status: null, page_title: null, redirect_chain: [], form_action_hosts: [],
          anti_bot_wall: null, error: null, screenshot_desktop_url: null, screenshot_mobile_url: null,
          html_download_url: null, sha256: { desktop: null, mobile: null, html: null },
        };
        qc.setQueryData<IdentityDetectionDetail>(key, { ...prev, captures: [optimistic, ...prev.captures].slice(0, 5) });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      // A 409 means one is really in flight: pull the truth so polling starts.
      void qc.invalidateQueries({ queryKey: key });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: key }); },
  });
}
