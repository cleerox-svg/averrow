/**
 * Single-agent review screen (AGENT_STANDARD §12.1).
 *
 * Reached via /v2/agents/:id/review. Shows the approval row + recent
 * agent_runs + recent agent_outputs (all from the review-bundle
 * endpoint) and lets a super_admin approve, reject, or request
 * changes.
 *
 * Phase 5.4c — frontend wiring on top of the data + endpoints from
 * 5.4a and the runner gate from 5.4b.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, ShieldAlert, MessageSquare } from 'lucide-react';

import { PageHeader, Card, Button, Badge } from '@/design-system/components';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { relativeTime, formatDuration } from '@/lib/time';
import { getAgentMetadata } from '@/lib/agent-metadata';
import { AgentIcon } from '@/components/brand/AgentIcon';
import {
  useReviewBundle,
  useApproveAgent,
  useRejectAgent,
  useRequestChangesAgent,
  type ApprovalState,
} from '@/hooks/useAgentApprovals';

function stateBadgeProps(state: ApprovalState): { severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'; label: string } {
  switch (state) {
    case 'pending': return { severity: 'medium', label: 'PENDING' };
    case 'changes_requested': return { severity: 'high', label: 'CHANGES REQUESTED' };
    case 'approved': return { severity: 'low', label: 'APPROVED' };
    case 'rejected': return { severity: 'critical', label: 'REJECTED' };
  }
}

function runStatusBadgeProps(status: string): { severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'; label: string } {
  switch (status) {
    case 'success':  return { severity: 'low', label: 'SUCCESS' };
    case 'partial':  return { severity: 'medium', label: 'PARTIAL' };
    case 'failed':   return { severity: 'critical', label: 'FAILED' };
    case 'running':  return { severity: 'info', label: 'RUNNING' };
    default:         return { label: status.toUpperCase() };
  }
}

export function AgentReview() {
  const { id: rawId } = useParams<{ id: string }>();
  const agentId = rawId ?? '';
  const { data, isLoading, isError, error, refetch } = useReviewBundle(agentId);
  const approveMutation = useApproveAgent();
  const rejectMutation = useRejectAgent();
  const requestChangesMutation = useRequestChangesAgent();

  const [notes, setNotes] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const meta = getAgentMetadata(agentId);
  const bundle = data ?? null;
  const approval = bundle?.approval ?? null;
  const isPending = approval?.state === 'pending' || approval?.state === 'changes_requested';

  const onApprove = async () => {
    setActionError(null);
    try {
      await approveMutation.mutateAsync({ agentId, notes });
      setNotes('');
      void refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const onReject = async () => {
    setActionError(null);
    if (notes.trim().length < 5) {
      setActionError('Reject requires reviewer notes (≥ 5 characters).');
      return;
    }
    try {
      await rejectMutation.mutateAsync({ agentId, notes });
      setNotes('');
      void refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRequestChanges = async () => {
    setActionError(null);
    if (notes.trim().length < 5) {
      setActionError('Request changes requires reviewer notes (≥ 5 characters).');
      return;
    }
    try {
      await requestChangesMutation.mutateAsync({ agentId, notes });
      setNotes('');
      void refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={meta?.displayName ?? agentId}
        subtitle={meta?.subtitle ?? `Agent deployment review for ${agentId}.`}
        back={{ label: 'Approval queue', to: '/agents/approvals' }}
      />

      <Link
        to="/agents/approvals"
        className="inline-flex items-center gap-2 font-mono text-[11px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <ArrowLeft size={14} /> Back to approval queue
      </Link>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {isError && (
        <Card style={{ padding: '24px' }}>
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="shrink-0 mt-0.5" style={{ color: 'var(--sev-critical)' }} />
            <div>
              <div className="font-mono text-sm font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                Failed to load review bundle
              </div>
              <div className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                {error instanceof Error ? error.message : String(error)}
              </div>
            </div>
          </div>
        </Card>
      )}

      {!isLoading && !isError && bundle === null && (
        <EmptyState
          icon={<ShieldAlert size={32} />}
          title="No approval row"
          description={`No approval entry exists for ${agentId}. The agent may not be registered, or its first run hasn't fired yet.`}
        />
      )}

      {bundle && approval && (
        <>
          {/* Approval state card */}
          <Card variant="active" style={{ padding: '24px' }}>
            <div className="flex items-start gap-4 mb-4">
              <span className="shrink-0 mt-0.5" style={{ color: meta?.color ?? 'var(--text-secondary)' }}>
                <AgentIcon agent={agentId} size={40} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  <span className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {meta?.displayName ?? agentId}
                  </span>
                  <Badge {...stateBadgeProps(approval.state)} size="xs" />
                  {meta?.category && (
                    <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' }}>
                      {meta.category}
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                  Requested {relativeTime(approval.requested_at)}
                  {approval.reviewed_at && (
                    <> · Last reviewed {relativeTime(approval.reviewed_at)} by {approval.reviewed_by ?? 'unknown'}</>
                  )}
                  {approval.source_pr && (
                    <> · <a href={approval.source_pr} target="_blank" rel="noreferrer" className="hover:underline">view source PR ↗</a></>
                  )}
                </div>
                {approval.reviewer_notes && (
                  <div className="font-mono text-[11px] italic mt-2 p-3 rounded" style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)' }}>
                    “{approval.reviewer_notes}”
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Action panel — only shown for pending / changes_requested */}
          {isPending && (
            <Card style={{ padding: '24px' }}>
              <div className="flex items-center gap-2 mb-3">
                <MessageSquare size={16} style={{ color: 'var(--text-secondary)' }} />
                <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                  Reviewer action
                </span>
              </div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Notes (required for reject / request changes; ≥ 5 chars)"
                className="w-full font-mono text-[12px] p-3 rounded mb-3"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: 'var(--text-primary)',
                  minHeight: '88px',
                  resize: 'vertical',
                }}
                rows={4}
              />
              {actionError && (
                <div className="font-mono text-[11px] mb-3" style={{ color: 'var(--sev-critical)' }}>
                  {actionError}
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="primary"
                  onClick={onApprove}
                  disabled={approveMutation.isPending}
                >
                  <ShieldCheck size={14} />
                  {approveMutation.isPending ? 'Approving…' : 'Approve'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onRequestChanges}
                  disabled={requestChangesMutation.isPending}
                >
                  Request changes
                </Button>
                <Button
                  variant="danger"
                  onClick={onReject}
                  disabled={rejectMutation.isPending}
                >
                  Reject
                </Button>
              </div>
            </Card>
          )}

          {/* Recent runs */}
          <Card style={{ padding: '24px' }}>
            <div className="font-mono text-[11px] uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>
              Recent runs ({bundle.recent_runs.length})
            </div>
            {bundle.recent_runs.length === 0 ? (
              <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                No runs recorded yet — this agent hasn't fired since deploy.
              </div>
            ) : (
              <div className="space-y-2">
                {bundle.recent_runs.map((run) => (
                  <div key={run.id} className="flex items-center gap-3 font-mono text-[11px] py-2 border-b last:border-b-0" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                    <Badge {...runStatusBadgeProps(run.status)} size="xs" />
                    <span style={{ color: 'var(--text-secondary)' }}>{relativeTime(run.started_at)}</span>
                    {run.duration_ms !== null && (
                      <span style={{ color: 'var(--text-tertiary)' }}>{formatDuration(run.duration_ms)}</span>
                    )}
                    {run.records_processed > 0 && (
                      <span style={{ color: 'var(--text-tertiary)' }}>{run.records_processed} rec</span>
                    )}
                    {run.error_message && (
                      <span className="italic truncate" style={{ color: 'var(--sev-critical)' }}>{run.error_message}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Recent outputs */}
          <Card style={{ padding: '24px' }}>
            <div className="font-mono text-[11px] uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>
              Recent outputs ({bundle.recent_outputs.length})
            </div>
            {bundle.recent_outputs.length === 0 ? (
              <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                No agent_outputs rows yet.
              </div>
            ) : (
              <div className="space-y-2">
                {bundle.recent_outputs.map((out) => (
                  <div key={out.id} className="py-2 border-b last:border-b-0" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center gap-2 font-mono text-[10px] mb-1" style={{ color: 'var(--text-tertiary)' }}>
                      <span className="uppercase tracking-wider">{out.type}</span>
                      {out.severity && <span style={{ color: 'var(--text-secondary)' }}>· {out.severity}</span>}
                      <span>· {relativeTime(out.created_at)}</span>
                    </div>
                    <div className="font-mono text-[12px]" style={{ color: 'var(--text-primary)' }}>{out.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
