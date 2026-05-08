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

// ─── AI Spend Trend ──────────────────────────────────────────────

export interface AiSpendWindowTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface AiSpendByAgent {
  agent_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface AiSpendDaily {
  day: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface AiSpendPayload {
  windows: {
    '24h': AiSpendWindowTotals;
    '7d':  AiSpendWindowTotals;
    '30d': AiSpendWindowTotals;
  };
  by_agent_30d: AiSpendByAgent[];
  daily_30d:    AiSpendDaily[];
  generated_at: string;
}

export function useAiSpend() {
  return useQuery({
    queryKey: ['metrics-ai-spend'],
    queryFn: async () => {
      const res = await api.get<AiSpendPayload>('/api/admin/metrics/ai-spend');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    // Backend caches at 5 min — AI spend trend is stable, no
    // need to poll faster.
    refetchInterval: 300_000,
  });
}

// ─── Geo Coverage Trend ─────────────────────────────────────────

export interface GeoCoverageWindow {
  window: '24h' | '7d' | '30d';
  mapped: number;
  total: number;
  unmapped: number;
  coverage_pct: number | null;
}

export interface GeoCoverageDaily {
  day: string;
  mapped: number;
  total: number;
  coverage_pct: number | null;
}

export interface GeoCoverageExhaustedByFeed {
  source_feed: string;
  threat_type: string;
  n: number;
}

export interface GeoCoveragePayload {
  windows: GeoCoverageWindow[];
  daily_30d: GeoCoverageDaily[];
  exhausted: {
    total: number;
    by_feed: GeoCoverageExhaustedByFeed[];
  };
  generated_at: string;
}

export function useGeoCoverage() {
  return useQuery({
    queryKey: ['metrics-geo-coverage'],
    queryFn: async () => {
      const res = await api.get<GeoCoveragePayload>('/api/admin/metrics/geo-coverage');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 300_000,
  });
}

// ─── Feed Failure Board ─────────────────────────────────────────

export interface FeedFailureVerdict {
  tone: 'success' | 'warning' | 'failed' | 'pending' | 'inactive';
  label: string;
}

export interface FeedFailureRow {
  feed_name: string;
  display_name: string;
  enabled: boolean;
  paused_reason: string | null;
  pulls: number;
  success: number;
  failed: number;
  partial: number;
  failure_rate_pct: number;
  records_ingested: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  consecutive_failures: number;
  threshold: number;
  pct_to_auto_pause: number;
  verdict: FeedFailureVerdict;
}

export interface FeedFailurePayload {
  totals_24h: {
    total_pulls: number;
    total_success: number;
    total_failed: number;
    total_records: number;
    feeds_active: number;
  };
  per_feed: FeedFailureRow[];
  recent_errors: Array<{
    feed_name: string;
    started_at: string;
    error_message: string;
  }>;
  generated_at: string;
}

export function useFeedFailures() {
  return useQuery({
    queryKey: ['metrics-feed-failures'],
    queryFn: async () => {
      const res = await api.get<FeedFailurePayload>('/api/admin/metrics/feed-failures');
      return res.data ?? null;
    },
    placeholderData: keepPreviousData,
    // Backend caches at 60s; poll at the same cadence so the table
    // refreshes about as fast as the underlying data moves.
    refetchInterval: 60_000,
  });
}
