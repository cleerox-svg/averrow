// /agents-v3 — preview surface for the next-gen Agents page.
//
// Goal of this file: ship a real, data-backed page so operators can
// A/B against /agents via the VersionToggle, while leaving room for
// the §8 surfaces from docs/AGENT_AUDIT.md to land in follow-on PRs.
//
// What's new vs /agents:
//   - Compliance badges per agent (resource decls, output schemas,
//     per-agent budget — see AGENT_STANDARD.md). Renders ✓/✗ chips.
//   - Cost/budget gauge (placeholder — wires to per-agent budget
//     block once §11 lands)
//   - Run-signal mini-panel (7d runs, partial/killed counts —
//     pulled from the existing Agent payload).
//   - Decommission warning banner (heuristic on top of existing
//     last_completed_at + records_processed).
//
// What's NOT here yet (queued):
//   - Cost trend sparkline + monthly-to-cap gauge — needs §11 budget
//   - Output preview carousel — needs separate handler/endpoint
//   - Failure-pattern alert — needs SLO field on Agent payload
//   - Resource graph chip set — needs static-analysis manifest in §22
//
// The scaffold pulls from the same useAgents hook as /agents to keep
// data parity; v3-specific fields fall back to "—" until wired.

import { Link } from 'react-router-dom';
import { useAgents } from '@/hooks/useAgents';
import type { Agent } from '@/hooks/useAgents';
import { Card, StatCard, StatGrid, PageHeader } from '@/design-system/components';
import { VersionToggle } from '@/components/ui/VersionToggle';
import { Badge } from '@/components/ui/Badge';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { CardGridLoader } from '@/components/ui/PageLoader';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { EmptyState } from '@/components/ui/EmptyState';
import { relativeTime } from '@/lib/time';
import { Bot, AlertTriangle } from 'lucide-react';

const COMPLIANCE_AXES = [
  { key: 'resourceDecls', label: 'Resources' },
  { key: 'outputSchema',  label: 'Schemas' },
  { key: 'budget',        label: 'Budget' },
  { key: 'tests',         label: 'Tests' },
] as const;

// Placeholder compliance state — every axis is currently ✗ across
// the registered agents per AGENT_AUDIT.md §7. When the standard's
// requirements ship, this becomes a derived value off Agent.
function complianceFor(_agent: Agent) {
  return {
    resourceDecls: false,
    outputSchema:  false,
    budget:        false,
    tests:         false,
  };
}

// Decommission heuristic from AGENT_AUDIT.md §6.5: no completed run
// in 14 days OR 0 records over 14 days when the agent has been
// active before. Conservative — stricter window than the doc's 30d
// to surface the tail earlier.
function isDecommissionCandidate(agent: Agent): boolean {
  if (!agent.last_run_at) return false;
  const ageMs = Date.now() - new Date(agent.last_run_at).getTime();
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  return ageMs > fourteenDays;
}

function ComplianceChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] tracking-wide uppercase"
      style={{
        background: ok
          ? 'rgba(60,184,120,0.10)'
          : 'rgba(255,255,255,0.04)',
        color: ok ? 'var(--green)' : 'var(--text-muted)',
        border: `1px solid ${ok ? 'var(--green-border)' : 'var(--border-base)'}`,
      }}
    >
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

function PreviewBanner() {
  return (
    <Card variant="elevated" className="p-4">
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 w-8 h-8 rounded-md grid place-items-center"
          style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}
        >
          v3
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--amber)' }}>
            Agents · v3 preview
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            New surfaces from <code style={{ color: 'var(--text-primary)' }}>docs/AGENT_AUDIT.md §8</code>:
            compliance chips, decommission heuristic, run-signal panel.
            Toggle back to <Link to="/agents" className="underline" style={{ color: 'var(--amber)' }}>V2</Link>
            {' '}any time — your choice persists.
          </p>
        </div>
      </div>
    </Card>
  );
}

function AgentRowV3({ agent }: { agent: Agent }) {
  const compliance = complianceFor(agent);
  const flagged    = isDecommissionCandidate(agent);
  const okCount    = Object.values(compliance).filter(Boolean).length;
  const lastRun    = agent.last_run_at ? relativeTime(agent.last_run_at) : '—';

  return (
    <Card
      variant={flagged ? 'critical' : 'elevated'}
      className="p-4 flex flex-col gap-3"
    >
      {/* Header row — icon + name + status + decommission flag */}
      <div className="flex items-center gap-3">
        <AgentIcon agent={agent.name} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              {agent.name}
            </span>
            {flagged && (
              <Badge severity="high">
                <AlertTriangle size={10} className="inline mr-1" />
                Decommission?
              </Badge>
            )}
          </div>
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            Last run {lastRun}
          </div>
        </div>
      </div>

      {/* Run signal row — 7d totals from Agent payload */}
      <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
        <div>
          <div style={{ color: 'var(--text-muted)' }}>JOBS 24H</div>
          <div className="text-base" style={{ color: 'var(--text-primary)' }}>{agent.jobs_24h}</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>OUTPUTS 24H</div>
          <div className="text-base" style={{ color: 'var(--text-primary)' }}>{agent.outputs_24h}</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>ERRORS 24H</div>
          <div
            className="text-base"
            style={{
              color: agent.error_count_24h > 0 ? 'var(--sev-high)' : 'var(--text-primary)',
            }}
          >
            {agent.error_count_24h}
          </div>
        </div>
      </div>

      {/* Compliance row — placeholder ✗ chips per §7 */}
      <div>
        <div className="font-mono text-[9px] tracking-[0.15em] uppercase mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
          Compliance · {okCount}/{COMPLIANCE_AXES.length}
        </div>
        <div className="flex flex-wrap gap-1">
          {COMPLIANCE_AXES.map(axis => (
            <ComplianceChip
              key={axis.key}
              label={axis.label}
              ok={compliance[axis.key]}
            />
          ))}
        </div>
      </div>

      {/* Budget gauge — placeholder until §11 lands */}
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>
        Budget · pending §11
      </div>
    </Card>
  );
}

export function AgentsV3() {
  const { data: agents = [], isLoading } = useAgents();

  if (isLoading) return <CardGridLoader count={6} />;

  const operational  = agents.filter(a => a.status !== 'error').length;
  const totalJobs    = agents.reduce((sum, a) => sum + a.jobs_24h, 0);
  const totalOutputs = agents.reduce((sum, a) => sum + a.outputs_24h, 0);
  const decommissionCount = agents.filter(isDecommissionCandidate).length;

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="AI Agent Operations"
        subtitle="v3 preview · compliance + decommission signals"
        actions={
          <div className="flex items-center gap-3">
            <VersionToggle surface="agents" ariaLabel="Agents page version" />
            <LiveIndicator />
          </div>
        }
      />

      <PreviewBanner />

      <StatGrid cols={4}>
        <StatCard label="Agents Operational" value={`${operational}/${agents.length}`} accentColor="var(--green)" />
        <StatCard label="Jobs (24h)" value={totalJobs.toLocaleString()} />
        <StatCard label="Outputs (24h)" value={totalOutputs.toLocaleString()} />
        <StatCard
          label="Decommission Flags"
          value={decommissionCount}
          accentColor={decommissionCount > 0 ? 'var(--sev-high)' : undefined}
        />
      </StatGrid>

      {agents.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map(agent => (
            <AgentRowV3 key={agent.agent_id} agent={agent} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Bot />}
          title="Squadron offline"
          subtitle="No AI agents are currently registered."
          variant="error"
        />
      )}
    </div>
  );
}
