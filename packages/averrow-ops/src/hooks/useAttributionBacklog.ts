// Attribution Backlog hook — PR-B from the 2026-05-16 audit, extended
// with the manual-attribution follow-up: pagination + search on the
// list, an actor-search picker, and attribute/dismiss mutations.
//
// Backed by:
//   GET  /api/admin/agents/attribution-backlog?q=&limit=&offset=
//   POST /api/admin/clusters/:id/attribution           { actor_id }
//   POST /api/admin/clusters/:id/attribution/dismiss
//   GET  /api/threat-actors?q=&limit=   (picker search)

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BacklogCluster {
  id: string;
  cluster_name: string | null;
  asns: string | null;
  countries: string | null;
  threat_count: number;
  confidence_score: number | null;
  status: string | null;
  first_detected: string | null;
  last_seen: string | null;
  attribution_attempted_at: string | null;
  nexus_brief_preview: string | null;
  agent_notes_preview: string | null;
}

export interface AttributionBacklogTotals {
  total_clusters: number;
  unattributed: number;
  attempted_unknown: number;
  never_attempted: number;
  dismissed: number;
}

export interface AttributionBacklogData {
  items: BacklogCluster[];
  totals: AttributionBacklogTotals;
  limit: number;
  offset: number;
  generated_at: string;
}

export const BACKLOG_PAGE_SIZE = 50;

export function useAttributionBacklog(opts: { page?: number; q?: string } = {}) {
  const { page = 1, q = '' } = opts;
  return useQuery({
    queryKey: ['attribution-backlog', page, q],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('limit', String(BACKLOG_PAGE_SIZE));
      params.set('offset', String((page - 1) * BACKLOG_PAGE_SIZE));
      if (q) params.set('q', q);
      const res = await api.get<AttributionBacklogData>(
        `/api/admin/agents/attribution-backlog?${params}`,
      );
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    // 60s — operator triages live; backend caches 60s too.
    refetchInterval: 60_000,
  });
}

/** Drop a cluster from every cached backlog page immediately — the
 *  server list is KV-cached for 60s, so waiting for invalidation would
 *  leave an actioned row on screen. */
function removeClusterFromCache(qc: ReturnType<typeof useQueryClient>, clusterId: string) {
  qc.setQueriesData<AttributionBacklogData | null>(
    { queryKey: ['attribution-backlog'] },
    (old) => old
      ? { ...old, items: old.items.filter(c => c.id !== clusterId) }
      : old,
  );
}

export function useAttributeCluster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ clusterId, actorId }: { clusterId: string; actorId: string }) => {
      const res = await api.post<{ cluster_id: string; actor_name: string; threats_fanned_out: number }>(
        `/api/admin/clusters/${encodeURIComponent(clusterId)}/attribution`,
        { actor_id: actorId },
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Attribution failed');
      return res.data;
    },
    onSuccess: (_d, vars) => {
      removeClusterFromCache(qc, vars.clusterId);
      void qc.invalidateQueries({ queryKey: ['attribution-backlog'] });
    },
  });
}

export function useDismissCluster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (clusterId: string) => {
      const res = await api.post<{ cluster_id: string; dismissed: boolean }>(
        `/api/admin/clusters/${encodeURIComponent(clusterId)}/attribution/dismiss`,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? 'Dismiss failed');
      return res.data;
    },
    onSuccess: (_d, clusterId) => {
      removeClusterFromCache(qc, clusterId);
      void qc.invalidateQueries({ queryKey: ['attribution-backlog'] });
    },
  });
}

// ─── Actor picker search ─────────────────────────────────────────

export interface ActorOption {
  id: string;
  name: string;
  country: string | null;
  attribution: string | null;
}

export function useActorSearch(q: string) {
  return useQuery<ActorOption[]>({
    queryKey: ['actor-search', q],
    queryFn: async () => {
      const res = await api.get<ActorOption[]>(
        `/api/threat-actors?q=${encodeURIComponent(q)}&limit=8`,
      );
      if (!res.success) throw new Error(res.error ?? 'Actor search failed');
      return (res.data ?? []).map(a => ({
        id: a.id, name: a.name, country: a.country ?? null, attribution: a.attribution ?? null,
      }));
    },
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
