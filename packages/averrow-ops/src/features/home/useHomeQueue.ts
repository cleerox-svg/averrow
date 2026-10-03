// Wires every "Needs you now" source hook to the pure queue model.
//
// Role gating happens HERE, at the hook layer: each source hook receives
// `enabled` from `enabledSources(role)`, so a role that may not call an
// endpoint never fires the request (a 4xx envelope would otherwise read as
// an empty, all-clear source). The hooks are always called, in a fixed order,
// to satisfy the rules of hooks; a disabled query simply never runs.

import { useAuth } from '@/lib/auth';
import { useAlertTriageSummary } from '@/hooks/useAlerts';
import { useCriticalBanner } from '@/hooks/useCriticalBanner';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import { usePendingApprovals } from '@/hooks/useAgentApprovals';
import { useAdminTakedowns } from '@/hooks/useTakedowns';
import { useAgents } from '@/hooks/useAgents';
import { useDashboardSnapshot } from '@/hooks/useDashboardSnapshot';
import { useAttributionBacklog } from '@/hooks/useAttributionBacklog';
import { useBrandCandidates } from '@/hooks/useBrandCandidates';
import {
  buildQueue,
  enabledSources,
  type HomeQueue,
  type QueueSourceId,
  type QueueSources,
  type SourceResult,
} from '@/lib/home-queue';

const TAKEDOWNS_POLL_MS = 120_000;

interface QueryLike<T> {
  data: T | undefined;
  isError: boolean;
  refetch: () => unknown;
}

function toResult<T>(enabled: boolean, q: QueryLike<T>): SourceResult<T> | undefined {
  if (!enabled) return undefined;
  if (q.data !== undefined) {
    return q.isError ? { status: 'ok', data: q.data, stale: true } : { status: 'ok', data: q.data };
  }
  return q.isError ? { status: 'error' } : { status: 'loading' };
}

export interface UseHomeQueue {
  queue: HomeQueue;
  /** Re-run one source's query (the "Couldn't check {source}" retry). */
  retry: (id: QueueSourceId) => void;
}

export function useHomeQueue(): UseHomeQueue {
  const { user } = useAuth();
  const on = enabledSources(user?.role);

  const alerts = useAlertTriageSummary({ enabled: on.alerts });
  const critical = useCriticalBanner({ enabled: on.critical_intel });
  const incidents = useIncidents({ onlyOpen: true, enabled: on.incidents });
  const approvals = usePendingApprovals({ enabled: on.approvals });
  // limit:1 — only `statusCounts` is read; the server returns them for the whole set.
  // That is an uncached list + COUNT + GROUP BY, so Home polls it every 2 min
  // instead of the default 30s.
  const takedowns = useAdminTakedowns({ limit: 1 }, { enabled: on.takedowns, refetchInterval: TAKEDOWNS_POLL_MS });
  const agents = useAgents({ enabled: on.agents });
  const snapshot = useDashboardSnapshot({ enabled: on.feeds });
  const attribution = useAttributionBacklog({ enabled: on.attribution });
  const candidates = useBrandCandidates('pending', { enabled: on.brand_candidates });

  const sources: QueueSources = {
    alerts: toResult(on.alerts, alerts),
    critical_intel: toResult(on.critical_intel, critical),
    incidents: toResult(on.incidents, incidents),
    approvals: toResult(on.approvals, approvals),
    takedowns: toResult(on.takedowns, takedowns),
    agents: toResult(on.agents, agents),
    feeds: toResult(on.feeds, snapshot),
    attribution: toResult(on.attribution, attribution),
    brand_candidates: toResult(on.brand_candidates, candidates),
  };

  const refetchers: Record<QueueSourceId, () => unknown> = {
    alerts: alerts.refetch,
    critical_intel: critical.refetch,
    incidents: incidents.refetch,
    approvals: approvals.refetch,
    takedowns: takedowns.refetch,
    agents: agents.refetch,
    feeds: snapshot.refetch,
    attribution: attribution.refetch,
    brand_candidates: candidates.refetch,
  };

  return {
    queue: buildQueue(sources),
    retry: (id) => { void refetchers[id](); },
  };
}
