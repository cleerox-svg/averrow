// /agents-v3 — preview surface for the next-gen Agents page.
//
// Iteration 2 (this file): four new surfaces from
// docs/AGENT_AUDIT.md §8 wired to existing data:
//   1. 24h activity sparkline per card (agent.activity)
//   2. Failure-pattern badge (derived from circuit_state +
//      error_count_24h / jobs_24h ratio + last_run_status)
//   3. Click-to-expand detail panel per card with output preview
//      + 7d run/error sparkline + last error message
//   4. Compliance chips per agent (placeholder ✗ until Phase 4
//      retrofits AGENT_STANDARD.md)
//
// Still queued (blocked on backend work):
//   - Per-agent cost gauge — needs §11 per-agent budget block
//   - Resource graph chip set — needs §22 static-analysis manifest
//
// The page reads from useAgents (parity with /agents). Per-agent
// detail data only fetches when a card expands — `enabled: !!agentName`
// gating in useAgentDetail / useAgentHealth keeps the cold page cheap.

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
import { relativeTime } from '@/lib/time';
import { Bot, AlertTriangle, ChevronDown } from 'lucide-react';

const COMPLIANCE_AXES = [
  { key: 'resourceDecls', label: 'Resources' },
  { key: 'outputSchema',  label: 'Schemas' },
  { key: 'budget',        label: 'Budget' },
  { key: 'tests',         label: 'Tests' },
] as const;

// Placeholder compliance state — every axis is currently ✗ across
// the registered agents per AGENT_AUDIT.md §7. Flips to ✓ once
// Phase 4 retrofits the standard.
function complianceFor(_agent: Agent) {
  return {
    resourceDecls: false,
    outputSchema:  false,
    budget:        false,
    tests:         false,
  };
}

function isDecommissionCandidate(agent: Agent): boolean {
  if (!agent.last_run_at) return false;
  const ageMs = Date.now() - new Date(agent.last_run_at).getTime();
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  return ageMs > fourteenDays;
}

// Derived from existing fields — no new payload needed. Worst-first
// so the highest-severity reason wins when multiple apply.
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
            failure-pattern detection, 24h activity sparkline, click-to-expand detail with
            output preview + 7d health, decommission heuristic, compliance chips.
            Toggle back to <Link to="/agents" className="underline" style={{ color: 'var(--amber)' }}>V2</Link>
            {' '}any time — your choice persists.
          </p>
        </div>
      </div>
    </Card>
  );
}

interface AgentCardProps {
  agent:      Agent;
  isSelected: boolean;
  onSelect:   () => void;
}

function AgentRowV3({ agent, isSelected, onSelect }: AgentCardProps) {
  const compliance     = complianceFor(agent);
  const decommission   = isDecommissionCandidate(agent);
  const failurePattern = failurePatternFor(agent);
  const okCount        = Object.values(compliance).filter(Boolean).length;
  const lastRun        = agent.last_run_at ? relativeTime(agent.last_run_at) : '—';

  // Card variant follows the worst signal: failure > decommission > clean
  const variant: 'elevated' | 'critical' =
    failurePattern?.severity === 'critical' || decommission ? 'critical' : 'elevated';

  return (
    <Card
      variant={variant}
      className="p-4 flex flex-col gap-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      {/* Header — icon + name + worst signal + chevron */}
      <div className="flex items-center gap-3">
        <AgentIcon agent={agent.name} size={28} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[13px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              {agent.name}
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

      {/* 24h activity sparkline + signal stats — single visual row */}
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

      {/* Compliance chips */}
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
    return (
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Loading 7d health…
      </div>
    );
  }
  const total = data.runs.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return (
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        No runs in last 7 days
      </div>
    );
  }
  return (
    <div className="flex items-end gap-3">
      <div>
        <div className="font-mono text-[9px] tracking-[0.15em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
          7d Runs
        </div>
        <ActivitySparkline data={data.runs} color="var(--amber)" width={140} height={32} />
      </div>
      {data.errors.some(e => e > 0) && (
        <div>
          <div className="font-mono text-[9px] tracking-[0.15em] uppercase mb-1" style={{ color: 'var(--sev-high)' }}>
            7d Errors
          </div>
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
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5"
        style={{ background: dotColor }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs line-clamp-2" style={{ color: 'var(--text-primary)' }}>
          {output.summary}
        </div>
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
    <Card variant="elevated" className="p-5 col-span-full" >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left — health + run stats */}
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
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>
                  Total runs
                </div>
                <div className="text-lg font-mono" style={{ color: 'var(--text-primary)' }}>
                  {detail.stats.total_runs}
                </div>
              </div>
              <div>
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>
                  Successes
                </div>
                <div className="text-lg font-mono" style={{ color: 'var(--green)' }}>
                  {detail.stats.successes}
                </div>
              </div>
              <div>
                <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>
                  Failures
                </div>
                <div
                  className="text-lg font-mono"
                  style={{ color: detail.stats.failures > 0 ? 'var(--sev-high)' : 'var(--text-primary)' }}
                >
                  {detail.stats.failures}
                </div>
              </div>
            </div>
          )}
          {agent.last_run_error && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--sev-high)' }}>
                Last error
              </div>
              <div className="font-mono text-[11px] p-2 rounded" style={{
                background:  'var(--sev-critical-bg)',
                color:       'var(--text-primary)',
                border:      '1px solid var(--sev-critical-border)',
              }}>
                {agent.last_run_error}
              </div>
            </div>
          )}
        </div>

        {/* Right — output preview */}
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Recent outputs · last 5
          </div>
          {isLoading ? (
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>Loading…</div>
          ) : recentOutputs.length === 0 ? (
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
              No outputs persisted yet
            </div>
          ) : (
            <div>
              {recentOutputs.map(o => <OutputRow key={o.id} output={o} />)}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function AgentsV3() {
  const { data: agents = [], isLoading } = useAgents();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  if (isLoading) return <CardGridLoader count={6} />;

  const operational       = agents.filter(a => a.status !== 'error').length;
  const totalJobs         = agents.reduce((sum, a) => sum + a.jobs_24h, 0);
  const totalOutputs      = agents.reduce((sum, a) => sum + a.outputs_24h, 0);
  const decommissionCount = agents.filter(isDecommissionCandidate).length;
  const failureCount      = agents.filter(a => failurePatternFor(a) !== null).length;

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="AI Agent Operations"
        subtitle="v3 preview · failure detection + click-to-inspect"
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

      {agents.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map(agent => (
            <Fragment key={agent.agent_id}>
              <AgentRowV3
                agent={agent}
                isSelected={selectedAgent === agent.name}
                onSelect={() =>
                  setSelectedAgent(prev => prev === agent.name ? null : agent.name)
                }
              />
              {selectedAgent === agent.name && (
                <AgentDetailPanelV3 agent={agent} />
              )}
            </Fragment>
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
