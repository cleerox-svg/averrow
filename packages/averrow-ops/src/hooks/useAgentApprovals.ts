/**
 * Hooks for AGENT_STANDARD §12.1 deployment-approval workflow.
 *
 * Backend lives in packages/trust-radar/src/handlers/agent-approvals.ts.
 * All endpoints are super_admin gated.
 *
 * Phase 5.4c — frontend wiring. Phase 5.4d (future) will add per-run
 * approval queues for `requiresApproval: true` agents.
 */

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── Types ───────────────────────────────────────────────────────

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'changes_requested';

export interface AgentApprovalRow {
  agent_id: string;
  state: ApprovalState;
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewer_notes: string | null;
  source_pr: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentReviewBundle {
  approval: AgentApprovalRow | null;
  recent_runs: Array<{
    id: string;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    status: string;
    error_message: string | null;
    records_processed: number;
    outputs_generated: number;
  }>;
  recent_outputs: Array<{
    id: string;
    type: string;
    summary: string;
    severity: string | null;
    created_at: string;
  }>;
}

interface PendingResponse {
  pending: AgentApprovalRow[];
  total: number;
}

// ─── Reads ───────────────────────────────────────────────────────

/** Pending + changes_requested agents — drives the approval queue
 *  page. Refreshes every 60s so a freshly-deployed agent appears in
 *  the queue without a manual reload. */
export function usePendingApprovals() {
  return useQuery({
    queryKey: ['agent-approvals', 'pending'],
    queryFn: async () => {
      const res = await api.get<PendingResponse>('/api/admin/agents/approvals/pending');
      return res.data ?? { pending: [], total: 0 };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

/** Single-agent review bundle — drives the /agents/:id/review screen.
 *  Includes the approval row + last 10 agent_runs + last 10
 *  agent_outputs so the reviewer doesn't need a second fetch. */
export function useReviewBundle(agentId: string) {
  return useQuery({
    queryKey: ['agent-approvals', 'review-bundle', agentId],
    queryFn: async () => {
      const res = await api.get<AgentReviewBundle>(
        `/api/admin/agents/approvals/${encodeURIComponent(agentId)}/review-bundle`,
      );
      return res.data ?? null;
    },
    enabled: agentId.length > 0,
    refetchInterval: 30_000,
  });
}

// ─── Writes ──────────────────────────────────────────────────────

interface ApprovalActionVars {
  agentId: string;
  notes?: string;
}

/** Approve the agent. Returns the updated approval row. Invalidates
 *  the approval queue + the per-agent review bundle on success. */
export function useApproveAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentId, notes }: ApprovalActionVars) => {
      const res = await api.post<AgentApprovalRow>(
        `/api/admin/agents/approvals/${encodeURIComponent(agentId)}/approve`,
        { notes: notes ?? '' },
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['agent-approvals'] });
      qc.invalidateQueries({ queryKey: ['agent-approvals', 'review-bundle', vars.agentId] });
    },
  });
}

export function useRejectAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentId, notes }: ApprovalActionVars & { notes: string }) => {
      const res = await api.post<AgentApprovalRow>(
        `/api/admin/agents/approvals/${encodeURIComponent(agentId)}/reject`,
        { notes },
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['agent-approvals'] });
      qc.invalidateQueries({ queryKey: ['agent-approvals', 'review-bundle', vars.agentId] });
    },
  });
}

export function useRequestChangesAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentId, notes }: ApprovalActionVars & { notes: string }) => {
      const res = await api.post<AgentApprovalRow>(
        `/api/admin/agents/approvals/${encodeURIComponent(agentId)}/request-changes`,
        { notes },
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['agent-approvals'] });
      qc.invalidateQueries({ queryKey: ['agent-approvals', 'review-bundle', vars.agentId] });
    },
  });
}
