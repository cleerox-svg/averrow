/**
 * Deployment-approval queue page (AGENT_STANDARD §12.1).
 *
 * Lists every agent currently in `pending` or `changes_requested`
 * state. Phase 5.4a created the data model + admin endpoints, 5.4b
 * wired the runner gate, and this page closes the loop so a
 * super_admin can see the queue and click into each agent's review
 * screen.
 *
 * Uses the existing TanStack Query hooks (usePendingApprovals).
 * Auto-refreshes every 60s.
 */

import { Link } from 'react-router-dom';
import { Clock, ShieldCheck, AlertTriangle } from 'lucide-react';

import { PageHeader, Card, Badge } from '@/design-system/components';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { relativeTime } from '@/lib/time';
import { getAgentMetadata } from '@/lib/agent-metadata';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { usePendingApprovals, type ApprovalState } from '@/hooks/useAgentApprovals';

function stateLabel(state: ApprovalState): string {
  switch (state) {
    case 'pending': return 'Awaiting review';
    case 'changes_requested': return 'Changes requested';
    case 'approved': return 'Approved';
    case 'rejected': return 'Rejected';
  }
}

function stateBadgeProps(state: ApprovalState): { severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'; label: string } {
  switch (state) {
    case 'pending': return { severity: 'medium', label: 'PENDING' };
    case 'changes_requested': return { severity: 'high', label: 'CHANGES REQUESTED' };
    case 'approved': return { severity: 'low', label: 'APPROVED' };
    case 'rejected': return { severity: 'critical', label: 'REJECTED' };
  }
}

export function AgentApprovals() {
  const { data, isLoading, isError, error } = usePendingApprovals();
  const pending = data?.pending ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent deployment approvals"
        subtitle="Review and approve newly-deployed agents before they run in production."
      />

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {isError && (
        <Card style={{ padding: '24px' }}>
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="shrink-0 mt-0.5" style={{ color: 'var(--sev-critical)' }} />
            <div>
              <div className="font-mono text-sm font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                Failed to load approval queue
              </div>
              <div className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                {error instanceof Error ? error.message : String(error)}
              </div>
            </div>
          </div>
        </Card>
      )}

      {!isLoading && !isError && pending.length === 0 && (
        <EmptyState
          icon={<ShieldCheck size={32} />}
          title="Queue is empty"
          description="No agents are awaiting review. Newly-deployed agents will land here automatically on first run."
        />
      )}

      {!isLoading && pending.length > 0 && (
        <div className="space-y-3">
          {pending.map((row) => {
            const meta = getAgentMetadata(row.agent_id);
            const badge = stateBadgeProps(row.state);
            return (
              <Link
                key={row.agent_id}
                to={`/agents/${encodeURIComponent(row.agent_id)}/review`}
                className="block"
              >
                <Card variant="active" style={{ padding: '20px', cursor: 'pointer' }}>
                  <div className="flex items-start gap-4">
                    <span className="shrink-0 mt-0.5" style={{ color: meta?.color ?? 'var(--text-secondary)' }}>
                      <AgentIcon agent={row.agent_id} size={32} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2 flex-wrap">
                        <span className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                          {meta?.displayName ?? row.agent_id}
                        </span>
                        <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                          {row.agent_id}
                        </span>
                        <Badge severity={badge.severity} label={badge.label} size="xs" />
                      </div>
                      {meta?.subtitle && (
                        <div className="font-mono text-[11px] mb-2" style={{ color: 'var(--text-secondary)' }}>
                          {meta.subtitle}
                        </div>
                      )}
                      <div className="flex items-center gap-4 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                        <span className="inline-flex items-center gap-1">
                          <Clock size={10} />
                          Requested {relativeTime(row.requested_at)}
                        </span>
                        {row.source_pr && (
                          <a
                            href={row.source_pr}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            View source PR →
                          </a>
                        )}
                        {row.reviewer_notes && (
                          <span className="italic truncate max-w-md">
                            “{row.reviewer_notes}”
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {stateLabel(row.state)}
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
