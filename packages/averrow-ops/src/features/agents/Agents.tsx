// /agents — Agent Operations page.
//
// Layout:
//   - Flight Control rendered as the page's SUPERVISOR section, full
//     width, separate from the worker grid (first-class concept,
//     not just-another-card).
//   - Worker agents grouped by AGENT_METADATA.category — Intelligence,
//     Response, Platform Ops, Synchronous AI, Meta.
//   - Each agent card shows upstream / downstream connectivity chips
//     from the TRIGGER_CHAIN constant (source: CLAUDE.md "Agent
//     trigger chain").
//   - Compliance chips: Registered ✓ + Metadata ✓ are derived from
//     real data; Schema + Budget remain ✗ until Phase 4 / §11 land.
//
// View modes:
//   - Grid (default) — supervisor + worker cards
//   - Network — interactive mind-map of the agent mesh with live
//     pulses on edges currently in flight
//
// Backend-blocked surfaces (still ✗):
//   - Per-agent cost gauge — needs §11 budget block
//   - Resource-graph chips — needs §22 static-analysis manifest

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useAgents, useAgentDetail, useAgentHealth, useAgentTokenUsage, useAgentRuns,
  useTriggerAgent, useToggleAgent, useResetAgentCircuit,
} from '@/hooks/useAgents';
import type { Agent, AgentOutput } from '@/hooks/useAgents';
import { usePendingApprovals } from '@/hooks/useAgentApprovals';
import { useAuth } from '@/lib/auth';
import { Card, StatCard, StatGrid, PageHeader } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { CardGridLoader } from '@/components/ui/PageLoader';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { EmptyState } from '@/components/ui/EmptyState';
import { RunStatusBlocks } from '@/components/ui/RunStatusBlocks';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';
import { countAgentsOnline } from '@/lib/agent-status';
import { relativeTime } from '@/lib/time';
import { Bot, AlertTriangle, ChevronDown, GitBranch, Shield } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
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
// Banner that surfaces pending agent-deployment approvals on the
// Agents page. Uses the existing usePendingApprovals hook (60s
// polling) which is already mounted by the AgentApprovals page —
// React Query dedupes the cache so this adds zero new requests
// when both pages are open. Kept off the Sidebar deliberately to
// avoid amplifying API load on every authenticated session.
function PendingApprovalsBanner() {
  const { data } = usePendingApprovals();
  const count = data?.pending?.length ?? 0;
  if (count === 0) return null;

  return (
    <Link
      to="/agents/approvals"
      className="block group"
      style={{
        padding: '12px 16px', borderRadius: 8,
        border: '1px solid var(--sev-medium-border, rgba(229,168,50,0.30))',
        background: 'var(--sev-medium-bg, rgba(229,168,50,0.08))',
        textDecoration: 'none',
      }}
    >
      <div className="flex items-center gap-3">
        <Shield size={16} style={{ color: 'var(--amber)', flexShrink: 0 }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {count === 1
              ? '1 agent awaiting deployment review'
              : `${count} agents awaiting deployment review`}
          </div>
          <div className="text-[11px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
            Newly-deployed agents are blocked until a super_admin approves them.
          </div>
        </div>
        <span
          className="text-[11px] font-mono uppercase tracking-wider px-2 py-1 rounded transition-colors"
          style={{
            background: 'var(--amber)',
            color: '#0A0F1C',
            fontWeight: 600,
          }}
        >
          Review →
        </span>
      </div>
    </Link>
  );
}

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

// Multi-series compact area chart for cards. All three series
// (runs / outputs / errors) ride on the main /api/agents payload
// — no per-card useAgentHealth fan-out. Same visual identity as
// the drill-down HealthChart but stripped of axes/tooltips for
// the dense card grid. Errors series only renders when the agent
// actually has any errors in the 24h window.
function CardHealthChart({
  runs, outputs, errors, runsColor, width = 120, height = 40,
}: {
  runs:      number[];
  outputs?:  number[];
  errors?:   number[];
  /** Tint used for the runs series — flips to sev-high when the
   *  agent matches a failure pattern, otherwise amber. */
  runsColor: string;
  width?:    number;
  height?:   number;
}) {
  if (!runs || runs.length === 0) return null;
  const N = runs.length;
  // Single shared y-scale across all series so they're comparable.
  const peak = Math.max(
    ...runs,
    ...(outputs ?? []),
    ...(errors  ?? []),
    1,
  );
  const stepX = N > 1 ? width / (N - 1) : width;

  function paths(series: number[]) {
    const points = series.map((v, i) => {
      const x = i * stepX;
      const y = height - (v / peak) * (height - 2) - 1;
      return { x, y };
    });
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L ${(N - 1) * stepX} ${height} L 0 ${height} Z`;
    return { line, area };
  }

  // Stable per-series gradient ids — derived from a single random
  // seed so the three gradients in this chart instance share a
  // namespace but don't collide with other cards.
  const seed = Math.random().toString(36).slice(2, 9);
  const gradRuns    = `card-runs-${seed}`;
  const gradOutputs = `card-out-${seed}`;
  const gradErrors  = `card-err-${seed}`;

  const runsP    = paths(runs);
  const outputsP = outputs ? paths(outputs) : null;
  const errorsP  = errors && errors.some(e => e > 0) ? paths(errors) : null;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={gradRuns} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%"  stopColor={runsColor} stopOpacity={0.40} />
          <stop offset="95%" stopColor={runsColor} stopOpacity={0} />
        </linearGradient>
        <linearGradient id={gradOutputs} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%"  stopColor="#22D3EE" stopOpacity={0.30} />
          <stop offset="95%" stopColor="#22D3EE" stopOpacity={0} />
        </linearGradient>
        <linearGradient id={gradErrors} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%"  stopColor="var(--sev-high)" stopOpacity={0.40} />
          <stop offset="95%" stopColor="var(--sev-high)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* Runs first (broadest gradient, base layer) */}
      <path d={runsP.area} fill={`url(#${gradRuns})`} />
      <path d={runsP.line} stroke={runsColor} strokeWidth={1.3} fill="none" strokeLinejoin="round" />
      {outputsP && (
        <>
          <path d={outputsP.area} fill={`url(#${gradOutputs})`} />
          <path d={outputsP.line} stroke="#22D3EE" strokeWidth={1.1} fill="none" strokeLinejoin="round" opacity={0.85} />
        </>
      )}
      {errorsP && (
        <>
          <path d={errorsP.area} fill={`url(#${gradErrors})`} />
          <path d={errorsP.line} stroke="var(--sev-high)" strokeWidth={1.1} fill="none" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
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
          <div className="flex flex-col items-end gap-1">
            <CardHealthChart
              runs={agent.activity}
              outputs={agent.outputs_per_hour}
              errors={agent.errors_per_hour}
              runsColor={failurePattern ? 'var(--sev-high)' : 'var(--amber)'}
              width={120}
              height={36}
            />
            {/* Multi-instance scaling — each column is an hour bucket,
                each row is a parallel instance. Reveals Flight Control
                scale-out (taller stacks) that the area chart flattens. */}
            <RunStatusBlocks
              ticks={agent.recent_ticks}
              fallbackActivity={agent.activity}
            />
            <div className="font-mono text-[8px] tracking-[0.12em] uppercase" style={{ color: 'var(--text-muted)' }}>
              24h shape · 5h instances
            </div>
          </div>
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

// Dual-area health chart — runs + outputs over the last 24 hourly
// buckets. Mirrors v2's drill-down chart per operator preference;
// gives more shape than the single-bar ActivitySparkline.
function HealthChart({ name }: { name: string }) {
  const { data, isLoading } = useAgentHealth(name);

  const chartData = useMemo(() => {
    if (!data) return [];
    const baseHour = new Date().getUTCHours();
    return data.runs.map((runs, i) => ({
      hour:    `${(baseHour + i) % 24}:00`,
      runs,
      errors:  data.errors[i] ?? 0,
      outputs: data.outputs[i] ?? 0,
    }));
  }, [data]);

  if (isLoading) {
    return <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>Loading 24h health…</div>;
  }
  if (!data || chartData.length === 0) {
    return <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>No runs in last 24 hours</div>;
  }

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="agents-v3-runsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="var(--amber)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--amber)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="agents-v3-outputsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#22D3EE" stopOpacity={0.30} />
              <stop offset="95%" stopColor="#22D3EE" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="agents-v3-errorsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="var(--sev-high)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--sev-high)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 9, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis hide />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--bg-elevated)',
              border:           '1px solid var(--border-base)',
              borderRadius:     8,
              fontSize:         11,
              fontFamily:       'var(--font-mono)',
              color:            'var(--text-primary)',
            }}
            labelStyle={{ color: 'var(--text-tertiary)' }}
            cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="runs"
            stroke="var(--amber)"
            strokeWidth={1.5}
            fill="url(#agents-v3-runsGrad)"
            name="Runs"
          />
          <Area
            type="monotone"
            dataKey="outputs"
            stroke="#22D3EE"
            strokeWidth={1.5}
            fill="url(#agents-v3-outputsGrad)"
            name="Outputs"
          />
          {data.errors.some(e => e > 0) && (
            <Area
              type="monotone"
              dataKey="errors"
              stroke="var(--sev-high)"
              strokeWidth={1.5}
              fill="url(#agents-v3-errorsGrad)"
              name="Errors"
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-3 mt-1 font-mono text-[9px] tracking-[0.12em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-2 rounded-sm" style={{ background: 'var(--amber)', opacity: 0.6 }} />
          Runs
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-2 rounded-sm" style={{ background: '#22D3EE', opacity: 0.6 }} />
          Outputs
        </span>
        {data.errors.some(e => e > 0) && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-2 rounded-sm" style={{ background: 'var(--sev-high)', opacity: 0.6 }} />
            Errors
          </span>
        )}
      </div>
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

// Admin control plane (GA1) — the trigger/toggle/reset-circuit endpoints
// already exist (requireAdmin); this surfaces them where operators look.
function AgentControlBar({ agent }: { agent: Agent }) {
  const trigger = useTriggerAgent();
  const toggle = useToggleAgent();
  const resetCircuit = useResetAgentCircuit();
  const isPaused = agent.circuit_state === 'manual_pause';
  const isTripped = agent.circuit_state === 'tripped';
  const busy = trigger.isPending || toggle.isPending || resetCircuit.isPending;
  const failed = trigger.isError || toggle.isError || resetCircuit.isError;

  const btn = (label: string, color: string, onClick: () => void) => (
    <button
      onClick={onClick}
      disabled={busy}
      className="font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md transition-all disabled:opacity-40"
      style={{ border: '1px solid var(--border-base)', background: 'transparent', color }}
    >
      {label}
    </button>
  );

  return (
    <div className="mb-4 pb-4 border-b flex flex-wrap items-center gap-2" style={{ borderColor: 'var(--border-base)' }}>
      <span className="font-mono text-[9px] tracking-[0.18em] uppercase mr-1" style={{ color: 'var(--text-tertiary)' }}>Controls</span>
      {btn(trigger.isPending ? 'Triggering…' : 'Trigger now', 'var(--amber)', () => trigger.mutate(agent.name))}
      {isPaused
        ? btn(toggle.isPending ? 'Resuming…' : 'Resume', 'var(--green)', () => toggle.mutate({ agentId: agent.name, enabled: true }))
        : btn(toggle.isPending ? 'Pausing…' : 'Pause', 'var(--text-secondary)', () => toggle.mutate({ agentId: agent.name, enabled: false }))}
      {isTripped && btn(resetCircuit.isPending ? 'Resetting…' : 'Reset circuit', 'var(--sev-high)', () => resetCircuit.mutate(agent.name))}
      {failed && <span className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>Action failed — retry</span>}
    </div>
  );
}

// Compact token formatter: 980 · 12.3k · 1.2M.
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function AgentDetailPanelV3({ agent }: { agent: Agent }) {
  const { data: detail, isLoading } = useAgentDetail(agent.name);
  const { data: tokenUsage } = useAgentTokenUsage();
  const recentOutputs = (detail?.outputs ?? []).slice(0, 5);
  const meta = AGENT_METADATA[agent.name as AgentId];
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  // token-usage keys by agent_runs.agent_id (canonical id); match either field.
  const tu = tokenUsage?.find(t => t.agent_id === agent.agent_id || t.agent_id === agent.name);

  return (
    <Card variant="elevated" className="p-5 col-span-full">
      {isAdmin && <AgentControlBar agent={agent} />}
      {meta?.subtitle && (
        <div className="mb-5 pb-4 border-b" style={{ borderColor: 'var(--border-base)' }}>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
            What it does
          </div>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {meta.subtitle}
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div>
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Health · 24h runs · outputs · errors
            </div>
            <HealthChart name={agent.name} />
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
          {/* Token usage (GA2) — the cost driver, surfaced where operators
              look. All-time per-agent from agent_runs.tokens_used. */}
          {tu && tu.total_tokens > 0 && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
                Token usage · all-time
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>Total</div>
                  <div className="text-lg font-mono" style={{ color: 'var(--amber)' }}>{fmtTokens(tu.total_tokens)}</div>
                </div>
                <div>
                  <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>In · Out</div>
                  <div className="text-sm font-mono pt-1" style={{ color: 'var(--text-secondary)' }}>
                    {fmtTokens(tu.total_input_tokens)} · {fmtTokens(tu.total_output_tokens)}
                  </div>
                </div>
                <div>
                  <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>Runs w/ AI</div>
                  <div className="text-lg font-mono" style={{ color: 'var(--text-primary)' }}>{tu.runs_with_tokens.toLocaleString()}</div>
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

// View mode — grid (cards) vs network (mind-map). Persisted per-device
// so the operator's preference sticks across reloads. Local to /agents.
type ViewMode = 'grid' | 'network';
const VIEW_MODE_KEY = 'averrow.agents-v3-view-mode';

function readViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    return v === 'network' ? 'network' : 'grid';
  } catch {
    return 'grid';
  }
}

function ViewModeToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const OPTIONS: Array<{ id: ViewMode; label: string }> = [
    { id: 'grid',    label: 'Grid'    },
    { id: 'network', label: 'Network' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Agents view mode"
      className="inline-flex rounded-md overflow-hidden"
      style={{
        border:     '1px solid var(--border-base)',
        background: 'var(--bg-input)',
      }}
    >
      {OPTIONS.map(opt => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className="px-2.5 py-1 font-mono text-[10px] tracking-[0.18em] uppercase transition-colors"
            style={{
              background: active ? 'var(--blue)' : 'transparent',
              color:      active ? '#0A0F1C' : 'var(--text-secondary)',
              fontWeight: active ? 600 : 500,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Agents() {
  const { data: agents = [], isLoading } = useAgents();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const isSuperAdmin = user?.role === 'super_admin';
  // Stalled runs (GA4) — stuck in 'running' >15min. The internal diagnostics
  // computes this; surface it operator-side from the runs endpoint.
  const { data: runningRuns } = useAgentRuns({ status: 'running', limit: 50 });
  const stalled = (runningRuns?.data ?? []).filter(
    r => Date.now() - new Date(r.started_at).getTime() > 15 * 60_000,
  );
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [viewMode, setViewModeState] = useState<ViewMode>(readViewMode);

  function setViewMode(v: ViewMode) {
    setViewModeState(v);
    try { localStorage.setItem(VIEW_MODE_KEY, v); } catch {}
  }

  // Cross-tab sync: another tab flipping the toggle updates this one too.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== VIEW_MODE_KEY) return;
      const next = e.newValue;
      if (next === 'grid' || next === 'network') setViewModeState(next);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

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
  const operational       = countAgentsOnline(agents);
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
        subtitle={`${agents.length} agents · ${supervisors.length} supervisor`}
        actions={
          <div className="flex items-center gap-3 flex-wrap">
            {/* Discoverability (GA3) — Approvals + Architect were URL-only. */}
            {isSuperAdmin && (
              <Link
                to="/agents/approvals"
                className="font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border transition-all"
                style={{ borderColor: 'var(--border-base)', color: 'var(--text-secondary)' }}
              >
                Approvals
              </Link>
            )}
            {isAdmin && (
              <Link
                to="/agents/architect"
                className="font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-md border transition-all"
                style={{ borderColor: 'var(--border-base)', color: 'var(--text-secondary)' }}
              >
                Architect
              </Link>
            )}
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
            <LiveIndicator />
          </div>
        }
      />

      <PendingApprovalsBanner />

      {/* Stalled runs (GA4) — stuck >15min, was only in internal diagnostics. */}
      {stalled.length > 0 && (
        <Card variant="critical" style={{ padding: '12px 16px' }}>
          <div className="flex items-center gap-2 mb-1.5">
            <AlertTriangle size={14} style={{ color: 'var(--sev-critical)' }} />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-primary)' }}>
              {stalled.length} stalled run{stalled.length !== 1 ? 's' : ''} · stuck &gt;15m
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {stalled.slice(0, 8).map(r => (
              <span key={r.id} className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                {r.agent_id} <span style={{ color: 'var(--text-muted)' }}>· started {relativeTime(r.started_at)}</span>
              </span>
            ))}
            {stalled.length > 8 && (
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>+{stalled.length - 8} more</span>
            )}
          </div>
        </Card>
      )}

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
      ) : viewMode === 'grid' ? (
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
      ) : (
        <>
          {/* Network view: detail panel renders above the network so
              clicking a node still surfaces context without scrolling. */}
          {selectedAgent && (() => {
            const sel = agents.find(a => a.name === selectedAgent);
            return sel ? <AgentDetailPanelV3 agent={sel} /> : null;
          })()}
          <NetworkSection
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={handleSelect}
          />
        </>
      )}
    </div>
  );
}
