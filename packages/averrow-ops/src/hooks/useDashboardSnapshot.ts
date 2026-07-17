// Tier 2a — single KV-cached composite the /admin LANDING reads instead of
// fanning out to ~6 independently-cached endpoints (system-health, budget
// status+breakdown, feed-failures, pipeline-status, email-security stats).
//
// Backend contract: packages/averrow-worker/src/handlers/admin.ts
// (`handleAdminDashboard`), routed at GET /api/admin/dashboard
// (requireAdmin), documented in docs/API_REFERENCE.md. Backend cache TTL
// is ~75s (`DASHBOARD_SNAPSHOT_TTL`) — staleTime/refetchInterval below
// match that cadence so this poller doesn't out-run the KV cache.
//
// Every slice is INDEPENDENTLY NULLABLE — a failed/absent slice is `null`,
// never a 500. `threat_health` is null for non-super_admin by design (it
// reuses a super-admin-only source, `handleSystemHealth`) — consumers must
// treat a null slice as "unknown/unavailable", never coerce it to zero or
// to "healthy". See VerdictBand.tsx for the canonical unknown-never-ok
// pattern this feeds.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BudgetStatus } from '@/hooks/useBudget';

export interface DashboardThreatHealthSlice {
  threats: { total: number; today: number; week: number };
  agents_24h: { total: number; successes: number; errors: number };
  feeds_24h: { pulls: number; ingested: number };
  active_sessions: number;
  trend_14d: Array<{ day: string; count: number }>;
}

export interface DashboardBudgetSlice {
  status: BudgetStatus;
  top_agents: Array<{ agent_id: string; cost_usd: number; calls: number }>;
}

export interface DashboardFeedAtRisk {
  feed_name: string;
  display_name: string;
  /** Pre-computed by the backend (handleAdminDashboard) — 'critical' covers
   *  auto-paused-from-failures feeds AND >=80% to auto-pause / high failure
   *  rate; 'high' covers 60-79% / failing. Read this directly instead of
   *  re-deriving severity from `verdict.label`. */
  severity: 'critical' | 'high';
  verdict: { tone: string; label: string };
  failure_rate_pct: number;
  pct_to_auto_pause: number;
  enabled: boolean;
  /** `feed_configs.paused_reason`; 'auto:consecutive_failures' marks a feed
   *  that died from failures (distinct from an operator-initiated pause). */
  paused_reason: string | null;
}

export interface DashboardFeedsSlice {
  /** ALL critical+high feeds, including auto-paused ones — not just the
   *  count of visible `at_risk` rows. See the hidden-rows guard in
   *  VerdictBand.tsx's feedsSeverity(). */
  at_risk_count: number;
  /** Capped to the first 20 at-risk feeds server-side, sorted
   *  critical-first — see `handleAdminDashboard`. Consumers that need an
   *  exact severity floor should treat `at_risk_count > at_risk.length` as
   *  "there are more at-risk feeds than we can see" rather than trusting
   *  the visible rows alone. */
  at_risk: DashboardFeedAtRisk[];
  totals_24h: {
    total_pulls: number;
    total_success: number;
    total_failed: number;
    feeds_active: number;
  };
}

export interface DashboardPipelineConcern {
  id: string;
  label: string;
  severity: 'critical' | 'warning';
  verdict: { tone: string; label: string };
  trend_direction: string;
  count: number;
}

export interface DashboardPipelineSlice {
  /** Reflects only genuine pipeline problems — a benign GeoIP
   *  SETUP/unconfigured state (or other benign 'pending' tones) is excluded
   *  server-side and never forces this away from 'ok'. */
  worst_tone: 'critical' | 'warning' | 'ok' | 'unknown';
  /** Renamed from `growing_or_stale_count` — a critical row may be an empty
   *  reference dataset, not a growing backlog, so the count (and any UI
   *  copy built from it) should stay neutral rather than assume "growing". */
  needs_attention_count: number;
  total_pipelines: number;
  /** Capped to the first 20 concerning pipelines server-side. */
  concerning: DashboardPipelineConcern[];
}

export interface DashboardEmailSecuritySlice {
  total_scanned: number;
  total_unscanned: number;
  average_score: number;
  grade_distribution: Array<{ grade: string; count: number }>;
  worst_count: number;
}

export interface DashboardSnapshot {
  threat_health: DashboardThreatHealthSlice | null;
  budget: DashboardBudgetSlice | null;
  feeds: DashboardFeedsSlice | null;
  pipeline: DashboardPipelineSlice | null;
  email_security: DashboardEmailSecuritySlice | null;
  generated_at: string;
}

/** Shared query key — exported so other hooks (e.g. useBudgetConfigMutation)
 *  can invalidate this cache entry after a mutation that changes what the
 *  snapshot reports (budget config edits), without hardcoding the key
 *  string in two files. */
export const DASHBOARD_SNAPSHOT_QUERY_KEY = ['admin-dashboard-snapshot'] as const;

export function useDashboardSnapshot() {
  return useQuery({
    queryKey: DASHBOARD_SNAPSHOT_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<DashboardSnapshot>('/api/admin/dashboard');
      return res.data ?? null;
    },
    // Backend KV cache TTL is ~75s (DASHBOARD_SNAPSHOT_TTL) — match cadence
    // so this poller stays roughly in step with the cache window instead of
    // either hammering a warm cache or sitting stale behind it.
    staleTime: 75_000,
    refetchInterval: 75_000,
  });
}
