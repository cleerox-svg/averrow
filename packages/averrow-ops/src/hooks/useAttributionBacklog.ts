// Attribution Backlog hook — PR-B from the 2026-05-16 audit.
//
// Surfaces infrastructure_clusters that don't have an actor_id.
// At audit time: 2,334 of 2,483 clusters (94%) — Attributor tried
// and failed 99.6% of the time. This queue is the admin entry
// point for routing the largest unattributed clusters to humans.

import { useQuery, keepPreviousData } from '@tanstack/react-query';
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
}

export interface AttributionBacklogData {
  items: BacklogCluster[];
  totals: AttributionBacklogTotals;
  generated_at: string;
}

export function useAttributionBacklog(limit = 50) {
  return useQuery({
    queryKey: ['attribution-backlog', limit],
    queryFn: async () => {
      const res = await api.get<AttributionBacklogData>(
        `/api/admin/agents/attribution-backlog?limit=${limit}`,
      );
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    // 60s — operator triages live, but the backend caches 5min.
    refetchInterval: 60_000,
  });
}
