// /agents-v3 — preview surface for the next-gen Agents page.
//
// Iteration 3 (this file): structural reorganisation.
//   - Flight Control rendered as the page's supervisor section, full
//     width, with a "SUPERVISOR" badge + the count of agents it
//     watches. Mirrors v2's pattern but treats it as a first-class
//     concept rather than just-another-card.
//   - Worker agents grouped by AGENT_METADATA.category — Detection,
//     Intelligence, Response, Operations, Synchronous AI.
//   - Each agent card surfaces upstream / downstream connectivity
//     chips encoded from CLAUDE.md's trigger chain. ← / → arrows
//     show event flow at a glance without leaving the card.
//   - Compliance chips now read real signals: Registered ✓ (Phase 2
//     finished), Metadata ✓ (lookup against AGENT_METADATA), and
//     ✗ for the still-pending Phase 4 axes (Schemas, Budget). Honest
//     2/4 instead of placeholder 0/4.
//
// Future (call out in the page footer for now):
//   - Interactive mind-map / neural-network visualisation of agent
//     trigger chains with live "work happening" pulses on edges.
//
// Still backend-blocked (placeholder chips):
//   - Per-agent cost gauge — needs §11 budget block
//   - Resource-graph chips — needs §22 static-analysis manifest

import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAgents, useAgentDetail, useAgentHealth } from '@/hooks/useAgents';
import type { Agent, AgentOutput } from '@/hooks/useAgents';
import { Card, StatCard, StatGrid, PageHeader } from '@/design-system/components';
import { VersionToggle } from '@/components/ui/VersionToggle';
import { Badge } from '@/components/ui/Badge';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { CardGridLoader } from '@/components/ui/PageLoader';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { ActivitySparkline } from '@/components/ui/ActivitySparkline';
import { EmptyState } from '@/components/ui/EmptyState';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';
import { relativeTime } from '@/lib/time';
import { Bot, AlertTriangle, ChevronDown, GitBranch, Shield } from 'lucide-react';
import { AgentNetworkView } from './components/AgentNetworkView';

// ─── Hierarchy: who manages who? ───────────────────────────────────
//
// Today only one agent is structurally a supervisor: Flight Control
// (parallel scaling, stall recovery, token budget enforcement). If
// future supervisors land — e.g. a per-domain "Trap Mesh" coordinator
// from AGENT_AUDIT §6.4 — add their ids here and they'll automatically
// render in the supervisor section above the worker grid.
const SUPERVISOR_AGENT_IDS: AgentId[] = ['flight_control'];

// ─── Trigger chain — encodes inter-agent event flow ───────────────
//
// Source of truth: CLAUDE.md "Agent trigger chain" + the dispatcher
// in cron/orchestrator.ts. Used to render upstream/downstream chips
// on each agent card so operators can see what feeds X / what X
// feeds without opening the agent's source file.
//
// Keep this minimal — only the structural fan-out edges that drive
// orchestration. Sync agents (handler-driven) don't appear here.
const TRIGGER_CHAIN: Partial<Record<AgentId, { upstream?: AgentId[]; downstream?: AgentId[] }>> = {
  sentinel:        { downstream: ['cartographer'] },
  cartographer:    { upstream: ['sentinel'], downstream: ['nexus'] },
  nexus:           { upstream: ['cartographer'], downstream: ['analyst', 'observer', 'attributor'] },
  analyst:         { upstream: ['nexus'], downstream: ['pathfinder'] },
  observer:        { upstream: ['nexus'], downstream: ['narrator', 'seed_strategist'] },
  attributor:      { upstream: ['nexus'] },
  pathfinder:      { upstream: ['analyst'] },
  narrator:        { upstream: ['observer'] },
  seed_strategist: { upstream: ['observer'], downstream: ['auto_seeder'] },
  auto_seeder:     { upstream: ['seed_strategist'] },
};

// ─── Worker groupings — 5 categories from AGENT_METADATA ──────────
const GROUP_LABELS: Record<string, { label: string; description: string }> = {
  intelligence: { label: 'Intelligence',     description: 'Detection, enrichment, correlation' },
  response:     { label: 'Response',         description: 'Takedowns + remediation' },
  ops:          { label: 'Platform Ops',     description: 'Health, hygiene, refresh jobs' },
  sync:         { label: 'Synchronous AI',   description: 'Handler-driven AI calls' },
  meta:         { label: 'Meta',             description: 'Internal audit + tooling' },
};

const COMPLIANCE_AXES = [
  { key: 'registered', label: 'Registered' },
  { key: 'metadata',   label: 'Metadata' },
  { key: 'schema',     label: 'Schema' },
  { key: 'budget',     label: 'Budget' },
] as const;

// Compliance signal — derived from real data:
//   - registered: present in AGENT_METADATA (proxy for agentModules)
//   - metadata:   AGENT_METADATA[name] has a non-default subtitle
//   - schema:     ✗ until Phase 4 retrofit lands
//   - budget:     ✗ until §11 per-agent budget block lands
function complianceFor(agent: Agent) {
  const meta = AGENT_METADATA[agent.name as AgentId];
  return {
    registered: !!meta,
    metadata:   !!meta && !!meta.subtitle,
    schema:     false,
    budget:     false,
  };
}

function isDecommissionCandidate(agent: Agent): boolean {
  if (!agent.last_run_at) return false;
  const ageMs = Date.now() - new Date(agent.last_run_at).getTime();
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  return ageMs > fourteenDays;
}

type FailurePattern =
  | { severity: 'critical'; label: string; reason: string }
  | { severity: 'high';     label: string; reason: string }
  | { severity: 'medium';   label: string; reason: string }
  | null;

function failurePatternFor(agent: Agent): FailurePattern {
  if (agent.circuit_state === 'tripped') {
    return {
      severity: 'critical',
      label:    'Circuit tripped',
      reason:   `${agent.consecutive_failures} consecutive failures`,
    };
  }
  if (agent.circuit_state === 'manual_pause') {
    return {
      severity: 'medium',
      label:    'Paused',
      reason:   agent.paused_reason ?? 'Manually paused',
    };
  }
  if (agent.last_run_status === 'failed' && agent.jobs_24h === 0) {
    return {
      severity: 'critical',
      label:    'Failing',
      reason:   'No successful run in 24h',
    };
  }
  const errorRate = agent.error_count_24h / Math.max(agent.jobs_24h, 1);
  if (agent.jobs_24h >= 5 && errorRate > 0.20) {
    return {
      severity: 'high',
      label:    'High error rate',
      reason:   `${Math.round(errorRate * 100)}% errors in 24h`,
    };
  }
  return null;
}

function ComplianceChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] tracking-wide uppercase"
      style={{
        background: ok ? 'rgba(60,184,120,0.10)' : 'rgba(255,255,255,0.04)',
        color:      ok ? 'var(--green)' : 'var(--text-muted)',
        border:     `1px solid ${ok ? 'var(--green-border)' : 'var(--border-base)'}`,
      }}
    >
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

function ConnectivityChips({ agentName }: { agentName: string }) {
  const chain = TRIGGER_CHAIN[agentName as AgentId];
  if (!chain || (!chain.upstream && !chain.downstream)) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap font-mono text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
      {chain.upstream && chain.upstream.length > 0 && (
        <>
          <span style={{ color: 'var(--text-muted)' }}>←</span>
          {chain.upstream.map(a => (
            <span
              key={a}
              className="px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)' }}
            >
              {a}
            </span>
          ))}
        </>
      )}
      {chain.downstream && chain.downstream.length > 0 && (
        <>
          <span style={{ color: 'var(--text-muted)' }}>→</span>
          {chain.downstream.map(a => (
            <span
              key={a}
              className="px-1.5 py-0.5 rounded"
              style={{
                background: 'var(--amber-glow)',
                color:      'var(--amber)',
                border:     '1px solid var(--amber-border)',
              }}
            >
              {a}
            </span>
          ))}
        </>
      )}
    </div>
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
            Supervisor sits up top, workers grouped by role, each card shows what feeds it
            and what it triggers. Compliance chips reflect real Phase 2 progress.
            Toggle back to <Link to="/agents" className="underline" style={{ color: 'var(--amber)' }}>V2</Link>
            {' '}any time — your choice persists.
          </p>
        </div>
      </div>
    </Card>
  );
}

function NetworkSection({
  agents,
  selectedAgent,
  onSelect,
}: {
  agents:        Agent[];
  selectedAgent: string | null;
  onSelect:      (name: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <GitBranch size={14} style={{ color: 'var(--blue)' }} />
        <span className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
          Network View
        </span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          · trigger chain · click a node to spotlight its subgraph
        </span>
      </div>
      <Card variant="elevated" className="p-4">
        <AgentNetworkView
          agents={agents}
          selectedAgent={selectedAgent}
          onSelect={onSelect}
        />
      </Card>
    </div>
  );
}

interface AgentCardProps {
  agent:      Agent;
  isSelected: boolean;
  onSelect:   () => void;
  variant?:   'elevated' | 'critical' | 'active';
}

function AgentRowV3({ agent, isSelected, onSelect, variant: variantOverride }: AgentCardProps) {
  const compliance     = complianceFor(agent);
  const decommission   = isDecommissionCandidate(agent);
  const failurePattern = failurePatternFor(agent);
  const okCount        = Object.values(compliance).filter(Boolean).length;
  const lastRun        = agent.last_run_at ? relativeTime(agent.last_run_at) : '—';
  const meta           = AGENT_METADATA[agent.name as AgentId];

  const variant: 'elevated' | 'critical' | 'active' =
    variantOverride
      ?? (failurePattern?.severity === 'critical' || decommission ? 'critical' : 'elevated');

  return (
    <Card
      variant={variant}
      className="p-4 flex flex-col gap-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      <div className="flex items-center gap-3">
        <AgentIcon agent={agent.name} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[13px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              {meta?.displayName ?? agent.name}
            </span>
            {failurePattern && (
              <Badge severity={failurePattern.severity}>
                <AlertTriangle size={10} className="inline mr-1" />
                {failurePattern.label}
              </Badge>
            )}
            {!failurePattern && decommission && (
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
        <ChevronDown
          size={14}
          style={{
            color:      'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        />
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono flex-1">
          <div>
            <div style={{ color: 'var(--text-muted)' }}>JOBS 24H</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>{agent.jobs_24h}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>OUTPUTS</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>{agent.outputs_24h}</div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>ERRORS</div>
            <div
              className="text-base"
              style={{ color: agent.error_count_24h > 0 ? 'var(--sev-high)' : 'var(--text-primary)' }}
            >
              {agent.error_count_24h}
            </div>
          </div>
        </div>
        {agent.activity && agent.activity.length > 0 && (
          <ActivitySparkline
            data={agent.activity}
            color={failurePattern ? 'var(--sev-high)' : 'var(--amber)'}
            width={80}
            height={28}
          />
        )}
      </div>

      <ConnectivityChips agentName={agent.name} />

      <div>
        <div className="font-mono text-[9px] tracking-[0.15em] uppercase mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
          Compliance · {okCount}/{COMPLIANCE_AXES.length}
        </div>
        <div className="flex flex-wrap gap-1">
          {COMPLIANCE_AXES.map(axis => (
            <ComplianceChip key={axis.key} label={axis.label} ok={compliance[axis.key]} />
          ))}
        </div>
      </div>

      {failurePattern && (
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {failurePattern.reason}
        </div>
      )}
    </Card>
  );
}

function HealthSparkline({ name }: { name: string }) {
  const { data, isLoading } = useAgentHealth(name);
  if (isLoading || !data) {
    return <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>Loading 7d health…</div>;
  }
  const total = data.runs.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>No runs in last 7 days</div>;
  }
  return (
    <div className="flex items-end gap-3">
      <div>
        <div className="font-mono text-[9px] tracking-[0.15em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>7d Runs</div>
        <ActivitySparkline data={data.runs} color="var(--amber)" width={140} height={32} />
      </div>
      {data.errors.some(e => e > 0) && (
        <div>
          <div className="font-mono text-[9px] tracking-[0.15em] uppercase mb-1" style={{ color: 'var(--sev-high)' }}>7d Errors</div>
          <ActivitySparkline data={data.errors} color="var(--sev-high)" width={140} height={32} />
        </div>
      )}
    </div>
  );
}

function OutputRow({ output }: { output: AgentOutput }) {
  const sev = output.severity?.toLowerCase();
  const dotColor =
    sev === 'critical' ? 'var(--sev-critical)'
    : sev === 'high'   ? 'var(--sev-high)'
    : sev === 'medium' ? 'var(--sev-medium)'
    : 'var(--text-muted)';
  return (
    <div className="flex items-start gap-2 py-1.5 border-t" style={{ borderColor: 'var(--border-base)' }}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={{ background: dotColor }} />
      <div className="min-w-0 flex-1">
        <div className="text-xs line-clamp-2" style={{ color: 'var(--text-primary)' }}>{output.summary}</div>
        <div className="font-mono text-[9px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          {output.type} · {relativeTime(output.created_at)}
        </div>
      </div>
    </div>
  );
}

function AgentDetailPanelV3({ agent }: { agent: Agent }) {
  const { data: detail, isLoading } = useAgentDetail(agent.name);
  const recentOutputs = (detail?.outputs ?? []).slice(0, 5);

  return (
    <Card variant="elevated" className="p-5 col-span-full">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div>
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Health · 7 day window
            </div>
            <HealthSparkline name={agent.name} />
          </div>
          {detail?.stats && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>Total runs</div>
                <div className="text-lg font-mono" style={{ color: 'var(--text-primary)' }}>{detail.stats.total_runs}</div>
              </div>
              <div>
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>Successes</div>
                <div className="text-lg font-mono" style={{ color: 'var(--green)' }}>{detail.stats.successes}</div>
              </div>
              <div>
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>Failures</div>
                <div className="text-lg font-mono" style={{ color: detail.stats.failures > 0 ? 'var(--sev-high)' : 'var(--text-primary)' }}>
                  {detail.stats.failures}
                </div>
              </div>
            </div>
          )}
          {agent.last_run_error && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--sev-high)' }}>Last error</div>
              <div className="font-mono text-[11px] p-2 rounded" style={{
                background: 'var(--sev-critical-bg)',
                color:      'var(--text-primary)',
                border:     '1px solid var(--sev-critical-border)',
              }}>
                {agent.last_run_error}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Recent outputs · last 5
          </div>
          {isLoading ? (
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : recentOutputs.length === 0 ? (
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>No outputs persisted yet</div>
          ) : (
            <div>{recentOutputs.map(o => <OutputRow key={o.id} output={o} />)}</div>
          )}
        </div>
      </div>
    </Card>
  );
}

function GroupHeader({ label, description, count }: { label: string; description: string; count: number }) {
  return (
    <div className="flex items-end justify-between gap-3 mb-3">
      <div>
        <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{description}</div>
      </div>
      <span
        className="font-mono text-[10px] px-2 py-0.5 rounded"
        style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)', border: '1px solid var(--border-base)' }}
      >
        {count}
      </span>
    </div>
  );
}

function SupervisorSection({
  supervisors,
  selectedAgent,
  onSelect,
}: {
  supervisors:   Agent[];
  selectedAgent: string | null;
  onSelect:      (name: string) => void;
}) {
  if (supervisors.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield size={14} style={{ color: 'var(--amber)' }} />
        <span className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
          Supervisors
        </span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          · agents managing other agents
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {supervisors.map(agent => (
          <Fragment key={agent.agent_id}>
            <AgentRowV3
              agent={agent}
              isSelected={selectedAgent === agent.name}
              onSelect={() => onSelect(agent.name)}
              variant="active"
            />
            {selectedAgent === agent.name && <AgentDetailPanelV3 agent={agent} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function AgentsV3() {
  const { data: agents = [], isLoading } = useAgents();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  if (isLoading) return <CardGridLoader count={6} />;

  // Partition: supervisors first, then workers grouped by category.
  const supervisorSet = new Set<string>(SUPERVISOR_AGENT_IDS);
  const supervisors = agents.filter(a => supervisorSet.has(a.name));
  const workers     = agents.filter(a => !supervisorSet.has(a.name));

  const groupedWorkers = new Map<string, Agent[]>();
  for (const agent of workers) {
    const meta = AGENT_METADATA[agent.name as AgentId];
    const cat  = meta?.category ?? 'meta';
    const existing = groupedWorkers.get(cat) ?? [];
    existing.push(agent);
    groupedWorkers.set(cat, existing);
  }
  // Stable ordering — render groups in this order regardless of map insertion.
  const GROUP_ORDER = ['intelligence', 'response', 'ops', 'sync', 'meta'];

  // Top-level stats
  const operational       = agents.filter(a => a.status !== 'error').length;
  const totalJobs         = agents.reduce((sum, a) => sum + a.jobs_24h, 0);
  const totalOutputs      = agents.reduce((sum, a) => sum + a.outputs_24h, 0);
  const decommissionCount = agents.filter(isDecommissionCandidate).length;
  const failureCount      = agents.filter(a => failurePatternFor(a) !== null).length;

  function handleSelect(name: string) {
    setSelectedAgent(prev => prev === name ? null : name);
  }

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="AI Agent Operations"
        subtitle={`v3 preview · ${agents.length} agents · ${supervisors.length} supervisor`}
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
          label="Failure Patterns"
          value={failureCount + decommissionCount}
          accentColor={(failureCount + decommissionCount) > 0 ? 'var(--sev-high)' : undefined}
        />
      </StatGrid>

      {agents.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="Squadron offline"
          subtitle="No AI agents are currently registered."
          variant="error"
        />
      ) : (
        <>
          <SupervisorSection
            supervisors={supervisors}
            selectedAgent={selectedAgent}
            onSelect={handleSelect}
          />

          {GROUP_ORDER.map(catKey => {
            const items = groupedWorkers.get(catKey);
            if (!items || items.length === 0) return null;
            const groupMeta = GROUP_LABELS[catKey] ?? { label: catKey, description: '' };
            return (
              <div key={catKey} className="space-y-3">
                <GroupHeader label={groupMeta.label} description={groupMeta.description} count={items.length} />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {items.map(agent => (
                    <Fragment key={agent.agent_id}>
                      <AgentRowV3
                        agent={agent}
                        isSelected={selectedAgent === agent.name}
                        onSelect={() => handleSelect(agent.name)}
                      />
                      {selectedAgent === agent.name && <AgentDetailPanelV3 agent={agent} />}
                    </Fragment>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}

      {agents.length > 0 && (
        <NetworkSection
          agents={agents}
          selectedAgent={selectedAgent}
          onSelect={handleSelect}
        />
      )}
    </div>
  );
}
