import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** One column in the run-status-blocks 2D timeline. Each tick is an
 *  hour bucket; `instances` are the (trigger, status)-deduped runs
 *  that landed in that bucket. Capped at 3 by the backend. */
export interface AgentTickInstance {
  /** Worst-case run outcome in this (bucket, trigger) group. */
  status: 'success' | 'failed' | 'partial' | 'running' | 'idle';
  /** 'cron' | 'flight_control' | 'event' | 'manual' | … */
  trigger: string;
  /** How many runs the row collapsed (12 cron firings/h for Navigator
   *  show as count=12 instead of 12 stacked tiles). */
  count: number;
  avg_duration_ms: number | null;
}
export interface AgentTick {
  /** UTC ISO 'YYYY-MM-DD HH:00:00' */
  bucket: string;
  /** 1–3 entries, ordered cron → flight_control → other. */
  instances: AgentTickInstance[];
}

export interface Agent {
  agent_id: string;
  name: string;
  display_name: string;
  description: string;
  color: string;
  status: string;
  schedule: string;
  jobs_24h: number;
  outputs_24h: number;
  error_count_24h: number;
  /** Hourly run counts over last 24h. Kept for any downstream chart
   *  that still expects the flat shape. */
  activity: number[];
  /** Newer per-tick shape that drives RunStatusBlocks (last 5 hours,
   *  oldest → newest). Empty for any agent that hasn't run in 5h. */
  recent_ticks: AgentTick[];
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_duration_ms: number | null;
  last_run_error: string | null;
  last_output_at: string | null;
  avg_duration_ms: number | null;
  // Circuit breaker fields
  circuit_enabled: number;
  circuit_state: 'closed' | 'tripped' | 'manual_pause';
  paused_reason: string | null;
  consecutive_failures: number;
  consecutive_failure_threshold: number | null;
  paused_at: string | null;
  paused_after_n_failures: number | null;
}

export interface AgentConfig {
  [key: string]: {
    schedule_label?: string;
    schedule?: string;
  };
}

export interface ApiUsage {
  tokens_24h: number;
  tokens_7d: number;
  tokens_30d: number;
  calls_today: number;
  daily_limit: number;
  estimated_cost_24h: string;
  estimated_cost_7d: string;
  estimated_cost_30d: string;
  agent_cost_30d: string;
  agent_calls_30d: number;
  ondemand_cost_30d: string;
  ondemand_calls_30d: number;
  api_key_configured: boolean;
}

export interface DashboardStats {
  users: {
    total: number;
    super_admins: number;
    admins: number;
    analysts: number;
    clients: number;
    active: number;
  };
  threats: {
    total: number;
    active: number;
  };
  sessions: {
    active: number;
  };
  agent_backlogs: {
    sentinel: number;
    analyst: number;
    cartographer: number;
    strategist: number;
    observer_last_run: string | null;
  };
  ai_attribution_pending: number;
  tranco_brand_count: number;
}

export interface PipelineStatus {
  name: string;
  pending: number;
  status: string;
  schedule: string;
}

export interface PipelineVerdict {
  /** Short uppercase label rendered as a pill, e.g. 'DRAINING',
   *  'GROWING', 'STEADY', 'STALE', 'CLEAR', 'UPDATED', 'STABLE',
   *  'EMPTY', 'SETUP'. Computed server-side so the encoding rule
   *  (backlog vs reference dataset) lives in one place. */
  label: string;
  /** Maps to Badge `status` so the pill picks up the existing
   *  design-system tones — green / amber / red / muted. */
  tone: 'success' | 'warning' | 'failed' | 'pending' | 'inactive';
}

export interface PipelineEntry {
  id: string;
  label: string;
  /** One-line plain-English subtitle ("what does this pipeline do?")
   *  surfaced under the label on the Agents-Monitor card. Optional —
   *  older v2 cache payloads don't include it. */
  description?: string;
  agent: string;
  schedule: string;
  /** External HTTP endpoints this pipeline calls (DNS resolvers,
   *  third-party APIs, etc.). Surfaced as small chips on the
   *  Pipeline Automation card. */
  endpoints: Array<{ name: string; url: string }> | null;
  count: number;
  prev_count: number | null;
  trend: number | null;
  trend_direction: 'up' | 'down' | 'flat' | 'unknown';
  /** One-word health verdict that replaces the cryptic trend-arrow
   *  text on the card. Computed server-side. Optional during the
   *  cache-bump window (older payloads stored under v2). */
  verdict?: PipelineVerdict;
  last_measured_at: string | null;
  agent_last_run_at: string | null;
  agent_last_status: string | null;
  agent_records_processed: number | null;
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await api.get<Agent[]>('/api/agents');
      return res.data || [];
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function useAgentConfig() {
  return useQuery({
    queryKey: ['agent-config'],
    queryFn: async () => {
      const res = await api.get<AgentConfig>('/api/admin/agents/config');
      return res.data || {};
    },
    placeholderData: keepPreviousData,
  });
}

export function useApiUsage() {
  return useQuery({
    queryKey: ['api-usage'],
    queryFn: async () => {
      const res = await api.get<ApiUsage>('/api/admin/agents/api-usage');
      return res.data || null;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ['admin-dashboard'],
    queryFn: async () => {
      const res = await api.get<DashboardStats>('/api/admin/stats');
      return res.data || null;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function usePipelineStatus(_agents?: Agent[] | undefined) {
  return useQuery({
    queryKey: ['pipeline-status-v2'],
    queryFn: async () => {
      const res = await api.get<PipelineEntry[]>('/api/admin/pipeline-status');
      return res.data ?? [];
    },
    placeholderData: keepPreviousData,
    refetchInterval: 300_000,
  });
}

export function useTriggerAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      const res = await api.post(`/api/agents/${agentId}/trigger`);
      return res.data ?? null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useResetAgentCircuit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      const res = await api.post(`/api/agents/${agentId}/reset-circuit`);
      return res.data ?? null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useUpdateAgentThreshold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentId, threshold }: { agentId: string; threshold: number | null }) => {
      const res = await api.put(`/api/agents/${agentId}/threshold`, { threshold });
      return res.data ?? null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export interface AgentRun {
  id: string;
  agent_id: string;
  status: string;
  records_processed: number;
  outputs_generated: number;
  duration_ms: number | null;
  tokens_used: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface AgentOutput {
  id: string;
  agent_id: string;
  type: string;
  summary: string;
  severity: string;
  details: string | null;
  related_brand_ids: string | null;
  related_campaign_id: string | null;
  related_provider_ids: string | null;
  created_at: string;
}

export interface AgentDetailResponse {
  agent: {
    name: string;
    displayName: string;
    description: string;
    color: string;
    trigger: string;
    requiresApproval: boolean;
  };
  runs: AgentRun[];
  outputs: AgentOutput[];
  stats: {
    total_runs: number;
    successes: number;
    failures: number;
    total_processed: number;
    total_outputs: number;
    avg_duration_ms: number | null;
  } | null;
}

export interface AgentHealthResponse {
  runs: number[];
  errors: number[];
  outputs: number[];
}

export function useAgentDetail(agentName: string) {
  return useQuery({
    queryKey: ['agent-detail', agentName],
    queryFn: async () => {
      const res = await api.get<AgentDetailResponse>(`/api/agents/${agentName}`);
      return res.data || null;
    },
    placeholderData: keepPreviousData,
    enabled: !!agentName,
    refetchInterval: 30_000,
  });
}

export function useAgentHealth(agentName: string) {
  return useQuery({
    queryKey: ['agent-health', agentName],
    queryFn: async () => {
      const res = await api.get<AgentHealthResponse>(`/api/agents/${agentName}/health`);
      return res.data || null;
    },
    placeholderData: keepPreviousData,
    enabled: !!agentName,
    refetchInterval: 30_000,
  });
}

// ─── Agent run history (paginated, filterable) ─────────────────
export interface AgentRunsParams {
  agent?: string;
  status?: string;
  window?: string;
  limit?: number;
  offset?: number;
}

export interface AgentRunsResponse {
  data: AgentRun[];
  total: number;
}

export function useAgentRuns(params: AgentRunsParams) {
  const qs = new URLSearchParams();
  if (params.agent) qs.set('agent', params.agent);
  if (params.status) qs.set('status', params.status);
  if (params.window) qs.set('window', params.window);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  const queryString = qs.toString();

  return useQuery({
    queryKey: ['agent-runs', queryString],
    queryFn: async () => {
      const res = await api.get<AgentRun[]>(`/api/agents/runs?${queryString}`);
      const rawData = res.data;
      return {
        data: Array.isArray(rawData) ? rawData : [],
        total: (res as unknown as { total?: number }).total ?? 0,
      };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

// ─── Token usage by agent ──────────────────────────────────────
export interface TokenUsageEntry {
  agent_id: string;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  runs_with_tokens: number;
}

export function useAgentTokenUsage() {
  return useQuery({
    queryKey: ['agent-token-usage'],
    queryFn: async () => {
      const res = await api.get<TokenUsageEntry[]>('/api/agents/token-usage');
      return res.data || [];
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useAgentOutputsByName(agentName: string) {
  return useQuery({
    queryKey: ['agent-outputs', agentName],
    queryFn: async () => {
      const res = await api.get<AgentOutput[]>(`/api/agents/${agentName}/outputs?limit=5`);
      return res.data || [];
    },
    placeholderData: keepPreviousData,
    enabled: !!agentName,
  });
}
