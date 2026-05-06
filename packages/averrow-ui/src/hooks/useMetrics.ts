// React Query hooks for the /admin/metrics page.
//
// Each section on the Metrics page fetches via its own focused
// endpoint instead of the heavyweight platform-diagnostics blob,
// so the page stays responsive and operators can refresh
// individual sections at independent rates (D1 stats refresh every
// 60s, AI spend every 5 min, etc.).

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── D1 Budget ───────────────────────────────────────────────────

export interface D1BudgetState {
  rows_read_24h: number | null;
  fetched_at: string | null;
  stale: boolean;
  daily_budget: number;
  warn_threshold: number;
  skip_threshold: number;
  pct_of_daily_budget: number | null;
  threshold_state: 'ok' | 'warn' | 'skip' | 'unknown';
  last_skip_at: string | null;
  skip_count_24h: number;
}

export interface D1Metrics24h {
  rows_read_24h: number | null;
  rows_written_24h: number | null;
  read_queries_24h: number | null;
  write_queries_24h: number | null;
  monthly_rows_read_projection: number | null;
  pct_of_25b_plan_ceiling: number | null;
  setup_required: boolean;
  setup_instructions?: string;
  error?: string;
}

export interface D1TopQuery {
  query_hash: string;
  query_sample: string;
  rows_read: number;
  rows_written: number;
  query_count: number;
  avg_rows_per_query: number;
}

export interface D1EndpointAttribution {
  endpoint: string;
  total_rows_read: number;
  total_queries: number;
  request_count: string;
  avg_rows_per_request: number;
}

export interface D1BudgetPayload {
  budget_state: D1BudgetState;
  metrics_24h: D1Metrics24h;
  top_queries: D1TopQuery[];
  top_queries_error: string | null;
  attribution: {
    by_endpoint: D1EndpointAttribution[];
    setup_required: boolean;
    setup_instructions: string | null;
    error: string | null;
  };
  generated_at: string;
}

export function useD1Budget() {
  return useQuery({
    queryKey: ['metrics-d1-budget'],
    queryFn: async () => {
      const res = await api.get<D1BudgetPayload>('/api/admin/metrics/d1-budget');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    // Backend caches at 60s; poll at the same cadence so the section
    // refreshes about as fast as the underlying data moves.
    refetchInterval: 60_000,
  });
}
