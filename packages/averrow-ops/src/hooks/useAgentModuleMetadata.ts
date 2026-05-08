/**
 * Hook for the per-agent module-metadata endpoint
 * (AGENT_STANDARD §3, §10, §11 surfaces).
 *
 * Drives the Phase 5.5 "Declarations" panel on the agent detail
 * screen — surfaces the AgentModule's declared budget vs current-
 * month spend, supervision, reads/writes, and output types.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ResourceDecl {
  kind: 'd1_table' | 'kv' | 'r2' | 'queue' | 'binding' | 'external';
  name?: string;
  namespace?: string;
  bucket?: string;
  prefix?: string;
  /** Only set for kind='external' — the base URL of the external
   *  HTTP dependency (DNS resolver, third-party API, etc.). */
  url?: string;
}

export interface AgentOutputDecl {
  type: string;
}

export interface AgentModuleMetadata {
  agent_id: string;
  display_name: string;
  description: string;
  category: string;
  status: string;
  pipeline_position: number;
  trigger: string;
  supervision: {
    stall_threshold_minutes: number;
    parallel_max: number;
    cost_guard: 'enforced' | 'exempt';
    requires_approval: boolean;
  };
  budget: {
    monthly_token_cap: number;
    alert_at: number;
    tokens_month: number;
    cost_usd_month: number;
    calls_month: number;
    pct_of_cap: number | null;
    over_alert_threshold: boolean;
    over_cap: boolean;
    rollup_updated_at: string | null;
  };
  resources: {
    reads: ResourceDecl[];
    writes: ResourceDecl[];
  };
  outputs: AgentOutputDecl[];
}

export function useAgentModuleMetadata(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ['agent-module-metadata', agentId],
    queryFn: async () => {
      if (!agentId) return null;
      const res = await api.get<AgentModuleMetadata>(
        `/api/admin/agents/${encodeURIComponent(agentId)}/module-metadata`,
      );
      return res.data ?? null;
    },
    enabled: !!agentId && agentId.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}
