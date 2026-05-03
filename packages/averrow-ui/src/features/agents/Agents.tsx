import { Fragment, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAgents, useAgentDetail, useAgentHealth, useAgentOutputsByName, useApiUsage, useDashboardStats, usePipelineStatus } from '@/hooks/useAgents';
import { usePendingApprovals } from '@/hooks/useAgentApprovals';
import { useGeoipRefresh } from '@/hooks/useGeoipRefresh';
import type { Agent, AgentDetailResponse, AgentHealthResponse, AgentOutput, PipelineEntry } from '@/hooks/useAgents';
import { Card, StatCard, StatGrid, PageHeader, Tabs } from '@/design-system/components';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Bot } from 'lucide-react';
import { CardGridLoader } from '@/components/ui/PageLoader';
import { Badge } from '@/components/ui/Badge';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { ActivitySparkline } from '@/components/ui/ActivitySparkline';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { HistoryView } from '@/components/agents/HistoryView';
import { ConfigView } from '@/components/agents/ConfigView';
import { AgentDeclarationsPanel } from '@/components/agents/AgentDeclarationsPanel';
import { relativeTime, formatDuration } from '@/lib/time';
import { cn } from '@/lib/cn';
import { getAgentMetadata, type AgentId } from '@/lib/agent-metadata';
import { AgentStatusBadge } from '@/components/AgentStatusBadge';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

type AgentTab = 'MONITOR' | 'HISTORY' | 'CONFIG';

// ─── Pending-approvals link (Phase 5.4c) ─────────────────────────
//
// Surfaces the count of agents currently in pending /
// changes_requested state and links to the queue page. Hidden when
// there's nothing pending so the header stays clean.
function PendingApprovalsLink() {
  const { data } = usePendingApprovals();
  const count = data?.total ?? 0;
  if (count === 0) return null;
  return (
    <Link
      to="/agents/approvals"
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded font-mono text-[10px] font-bold uppercase tracking-wide hover:opacity-100"
      style={{
        background: 'rgba(229,168,50,0.12)',
        color: 'var(--amber)',
        border: '1px solid rgba(229,168,50,0.30)',
        opacity: 0.95,
      }}
      title="Agents awaiting deployment review (AGENT_STANDARD §12.1)"
    >
      <ShieldCheck size={12} />
      {count} pending
    </Link>
  );
}

// ─── Visual grouping ────────────────────────────────────────────────
//
// Flight Control sits above as the supervisor card. Everything else is
// grouped here by role — Detection (eyes & ears), Intelligence (analysis
// & narrative), Response (taking action), Operations (platform health
// & growth), and Meta (auditing the platform itself).
//
// Listing agent ids explicitly keeps the order deterministic and lets us
// move agents between groups without touching agent-metadata.ts.
interface AgentGroup {
  id: string;
  label: string;
  agentIds: AgentId[];
}

const AGENT_GROUPS: AgentGroup[] = [
  {
    id: 'detection',
    label: 'Detection & Surveillance',
    agentIds: [
      'sentinel',
      'navigator',
      'cartographer',
      'nexus',
      'analyst',
      'social_discovery',
      'social_monitor',
      'app_store_monitor',
      'dark_web_monitor',
      'seed_strategist',
      'auto_seeder',
      'lookalike_scanner',
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence & Analysis',
    agentIds: ['observer', 'strategist', 'narrator', 'notification_narrator'],
  },
  {
    id: 'response',
    label: 'Response',
    agentIds: ['sparrow'],
  },
  {
    id: 'operations',
    label: 'Platform Operations',
    agentIds: ['pathfinder', 'curator', 'watchdog', 'cube_healer', 'enricher', 'geoip_refresh'],
  },
  {
    // Synchronous AI agents — handler-driven (not cron-scheduled).
    // Each one wraps an inline AI call from a public/admin handler;
    // see AGENT_STANDARD §2 + §7.4. Phase 3 of the agent audit migrates
    // 15 such call-sites into this group, one per PR.
    id: 'sync',
    label: 'Synchronous AI',
    agentIds: ['public_trust_check', 'qualified_report', 'brand_analysis', 'brand_report', 'brand_deep_scan', 'honeypot_generator', 'brand_enricher', 'admin_classify', 'url_scan', 'scan_report', 'social_ai_assessor', 'geo_campaign_assessment', 'evidence_assembler'],
  },
  // 'meta' group (architect) retired 2026-04-29 — see agent-metadata.ts.
];

// ─── Status helpers ─────────────────────────────────────────────────
function pipelineDotClass(status: string): string {
  if (status === 'active') return 'dot-pulse-green';
  if (status === 'error') return 'dot-pulse-red';
  if (status === 'degraded') return 'dot-pulse-amber';
  return '';
}

const severityVariant: Record<string, 'critical' | 'high' | 'medium' | 'low' | 'default'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

// ─── Run status blocks (last 5 runs) ───────────────────────────────
function RunStatusBlocks({ activity }: { activity: number[] }) {
  const last5 = activity.slice(-5);
  while (last5.length < 5) last5.unshift(0);
  return (
    <div className="flex gap-1">
      {last5.map((val, i) => (
        <div
          key={i}
          className={cn(
            'w-5 h-2 rounded-sm',
            val > 0 ? 'bg-positive' : 'bg-white/10',
          )}
        />
      ))}
    </div>
  );
}

// ─── Schedule Badge ──────────────────────────────────────────────
//
// Tiny schedule pill rendered beside the status/circuit badges. Navigator
// runs on an independent 5-minute cron that FC observes but doesn't
// dispatch, so it's rendered in the accent color instead of the muted
// fill the rest use.
function ScheduleBadge({ agent }: { agent: Agent }) {
  const schedule = agent.schedule;
  if (!schedule || schedule === '-') return null;
  const isIndependent = agent.name === 'navigator';
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[9px] font-medium uppercase tracking-wide"
      style={
        isIndependent
          ? { background: 'rgba(56,189,248,0.12)', color: '#7dd3fc', border: '1px solid rgba(56,189,248,0.3)' }
          : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.08)' }
      }
      title={isIndependent ? 'Independent cron — Flight Control monitors but does not dispatch' : 'Dispatched by Flight Control'}
    >
      {schedule}
    </span>
  );
}

// ─── Circuit Breaker Badge ──────────────────────────────────────────
function CircuitBadge({ agent }: { agent: Agent }) {
  if (agent.circuit_state === 'tripped') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] font-bold uppercase tracking-wide"
        style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }}
      >
        TRIPPED{agent.paused_after_n_failures ? ` \u00B7 ${agent.paused_after_n_failures}\u2717` : ''}
      </span>
    );
  }
  if (agent.circuit_state === 'manual_pause') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] font-bold uppercase tracking-wide"
        style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.1)' }}
      >
        Paused &middot; manual
      </span>
    );
  }
  return null;
}

// ─── Agent Card ─────────────────────────────────────────────────────
function AgentCard({
  agent,
  isSelected,
  onSelect,
}: {
  agent: Agent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const meta = getAgentMetadata(agent.name);
  const agentColor = meta?.color ?? agent.color;

  return (
    <Card
      variant={agent.circuit_state === 'tripped' ? 'critical' : agent.status === 'error' ? 'critical' : agent.status === 'active' ? 'active' : 'base'}
      className={cn(
        'card-accent-top transition-all duration-200 group',
        isSelected && 'scale-[1.01]',
      )}
      style={{ padding: '20px', cursor: 'pointer' }}
      onClick={onSelect}
    >
      {/* Header */}
      <div className="flex items-start gap-3 mb-4">
        <span className="shrink-0 mt-0.5" style={{ color: agentColor }}>
          <AgentIcon agent={agent.name} size={32} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-mono text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
              {meta?.displayName ?? agent.display_name}
            </span>
            <AgentStatusBadge status={agent.status} />
            <CircuitBadge agent={agent} />
            <ScheduleBadge agent={agent} />
          </div>
          <div className="font-mono text-[10px] text-white/40 leading-relaxed line-clamp-2">
            {meta?.subtitle ?? agent.description}
          </div>
        </div>
      </div>

      {/* 3-metric row */}
      <div className="flex gap-5 mb-4">
        <div>
          <div className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{agent.jobs_24h}</div>
          <div className="font-mono text-[9px] text-white/40 uppercase tracking-wider">Jobs 24h</div>
        </div>
        <div>
          <div className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{agent.outputs_24h}</div>
          <div className="font-mono text-[9px] text-white/40 uppercase tracking-wider">Outputs</div>
        </div>
        <div>
          <div
            className="font-display text-lg font-bold"
            style={{ color: agent.error_count_24h > 0 ? '#C83C3C' : 'var(--text-primary)' }}
          >
            {agent.error_count_24h}
          </div>
          <div className="font-mono text-[9px] text-white/40 uppercase tracking-wider">Errors</div>
        </div>
      </div>

      {/* Last output + status blocks */}
      <div className="flex items-center justify-between">
        <div className="font-mono text-[9px] text-white/50">
          Last output: {relativeTime(agent.last_output_at)}
        </div>
        <RunStatusBlocks activity={agent.activity} />
      </div>
    </Card>
  );
}

// ─── Flight Control Supervisor Card ─────────────────────────────────
function FlightControlCard({
  agent,
  allAgents,
  isSelected,
  onSelect,
}: {
  agent: Agent;
  allAgents: Agent[];
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { data: apiUsage } = useApiUsage();
  const { data: dashStats } = useDashboardStats();

  const tokenBudget = 500_000;
  const tokensUsed = apiUsage?.tokens_24h ?? 0;
  const tokenPct = Math.min((tokensUsed / tokenBudget) * 100, 100);

  const tokenBarColor = tokenPct >= 90 ? '#C83C3C' : tokenPct >= 80 ? '#FB923C' : '#22D3EE';

  return (
    <Card
      variant={agent.status === 'error' ? 'critical' : 'active'}
      className="col-span-1 sm:col-span-2 lg:col-span-3 card-accent-top transition-all duration-200"
      style={{ padding: '24px', cursor: 'pointer' }}
      onClick={onSelect}
    >
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left: FC identity */}
        <div className="flex items-start gap-3 lg:w-64 shrink-0">
          <span className="shrink-0 mt-0.5" style={{ color: '#22D3EE' }}>
            <AgentIcon agent="flight_control" size={36} />
          </span>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Flight Control</span>
              <AgentStatusBadge status={agent.status} />
            </div>
            <div className="font-mono text-[10px] text-white/40 leading-relaxed">
              {getAgentMetadata('flight_control')?.subtitle}
            </div>
          </div>
        </div>

        {/* Center: Agent mesh bubbles, grouped by metadata category. */}
        {/* Groups appear in pipeline order (intelligence → response → ops → meta).
            Agents without metadata fall into "Other" so nothing disappears. */}
        <div className="flex-1">
          <div className="font-mono text-[9px] text-white/40 uppercase tracking-widest mb-3">Agent Mesh</div>
          <div className="space-y-3">
            {(() => {
              const groupOrder: Array<{ key: string; label: string }> = [
                { key: 'intelligence', label: 'Detection & Intelligence' },
                { key: 'response',     label: 'Response' },
                { key: 'ops',          label: 'Operations' },
                { key: 'sync',         label: 'Synchronous AI' },
                { key: 'meta',         label: 'Meta' },
                { key: 'other',        label: 'Other' },
              ];

              // Bucket every non-FC agent by its metadata category.
              // Unknown / missing metadata → 'other' so the agent still
              // renders (defensive — never make an agent disappear from
              // the mesh just because we forgot to wire its metadata).
              const buckets: Record<string, typeof allAgents> = {
                intelligence: [], response: [], ops: [], sync: [], meta: [], other: [],
              };
              for (const a of allAgents) {
                if (a.name === 'flight_control') continue;
                const meta = getAgentMetadata(a.name);
                const cat = (meta?.category as string | undefined) ?? 'other';
                (buckets[cat] ?? buckets.other).push(a);
              }

              return groupOrder.map(({ key, label }) => {
                const agents = buckets[key] ?? [];
                if (agents.length === 0) return null;
                return (
                  <div key={key}>
                    <div className="font-mono text-[8px] text-white/30 uppercase tracking-widest mb-1.5">
                      {label}
                      <span className="text-white/20 ml-2 normal-case tracking-normal">{agents.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {agents.map(a => {
                        const m = getAgentMetadata(a.name);
                        return (
                          <div
                            key={a.name}
                            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
                            style={{
                              background: 'transparent',
                              border: '1px solid var(--border-base)',
                            }}
                          >
                            <AgentStatusBadge status={a.status} />
                            <span
                              className="font-mono text-[10px]"
                              style={{ color: m?.color ?? a.color }}
                            >
                              {m?.displayName ?? a.display_name}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>

        {/* Right: Token budget + backlogs */}
        <div className="lg:w-72 shrink-0 space-y-3">
          {/* Token budget bar */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="font-mono text-[9px] text-white/40 uppercase tracking-widest">Token Budget</span>
              <span className="font-mono text-[10px] text-white/60">
                {tokensUsed.toLocaleString()} / {tokenBudget.toLocaleString()}
              </span>
            </div>
            <div className="progress-bar-track h-2">
              <div
                className={cn(
                  tokenPct >= 90 ? 'progress-bar-fill-red' : tokenPct >= 80 ? 'progress-bar-fill-amber' : 'progress-bar-fill-teal',
                )}
                style={{ width: `${tokenPct}%` }}
              />
            </div>
          </div>

          {/* Backlog counters */}
          <div className="flex gap-4">
            <div>
              <div className="font-display text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {dashStats?.agent_backlogs?.cartographer?.toLocaleString() ?? '—'}
              </div>
              <div className="font-mono text-[8px] text-white/50 uppercase">Cart backlog</div>
            </div>
            <div>
              <div className="font-display text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {dashStats?.agent_backlogs?.analyst?.toLocaleString() ?? '—'}
              </div>
              <div className="font-mono text-[8px] text-white/50 uppercase">Analyst backlog</div>
            </div>
            <div>
              <div className="font-display text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{agent.jobs_24h}</div>
              <div className="font-mono text-[8px] text-white/50 uppercase">FC Jobs 24h</div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Detail Panel ───────────────────────────────────────────────────
function AgentDetailPanel({ agent }: { agent: Agent }) {
  const { data: detail } = useAgentDetail(agent.name);
  const { data: health } = useAgentHealth(agent.name);
  const { data: outputs } = useAgentOutputsByName(agent.name);
  const meta = getAgentMetadata(agent.name);
  const agentColor = meta?.color ?? agent.color;

  const typedDetail = detail as AgentDetailResponse | null;
  const typedHealth = health as AgentHealthResponse | null;

  const successRate = useMemo(() => {
    if (!typedDetail?.stats) return null;
    const { successes, total_runs } = typedDetail.stats;
    if (total_runs === 0) return null;
    return ((successes / total_runs) * 100).toFixed(1);
  }, [typedDetail]);

  const chartData = useMemo(() => {
    if (!typedHealth) return [];
    return typedHealth.runs.map((duration, i) => ({
      hour: `${(new Date().getUTCHours() + i) % 24}:00`,
      duration,
      outputs: typedHealth.outputs[i] ?? 0,
    }));
  }, [typedHealth]);

  return (
    <Card className="col-span-1 sm:col-span-2 lg:col-span-3 animate-fade-in" style={{ padding: '24px' }}>
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Left: Agent info */}
        <div className="lg:w-72 shrink-0 space-y-4">
          <div className="flex items-start gap-3">
            <span style={{ color: agentColor }}>
              <AgentIcon agent={agent.name} size={40} />
            </span>
            <div>
              <h3 className="font-mono text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {meta?.displayName ?? agent.display_name}
              </h3>
              <div className="font-mono text-[10px] text-white/40 mt-0.5">
                {meta?.subtitle ?? agent.description}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <DetailRow label="Schedule" value={agent.schedule} />
            <DetailRow label="Avg Duration" value={formatDuration(agent.avg_duration_ms)} />
            <DetailRow
              label="Success Rate"
              value={successRate ? `${successRate}%` : '—'}
            />
            <DetailRow label="Status">
              <AgentStatusBadge status={agent.status} />
            </DetailRow>
          </div>
        </div>

        {/* Right: Health chart */}
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[9px] text-white/40 uppercase tracking-widest mb-3">
            24h Health — Duration (ms) & Outputs
          </div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="durationGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22D3EE" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22D3EE" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="outputsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#FB923C" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#FB923C" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)', fontFamily: 'JetBrains Mono' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1520',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 8,
                    fontSize: 11,
                    fontFamily: 'JetBrains Mono',
                  }}
                  labelStyle={{ color: 'rgba(255,255,255,0.5)' }}
                />
                <Area
                  type="monotone"
                  dataKey="duration"
                  stroke="#22D3EE"
                  strokeWidth={1.5}
                  fill="url(#durationGrad)"
                  name="Duration (ms)"
                />
                <Area
                  type="monotone"
                  dataKey="outputs"
                  stroke="#FB923C"
                  strokeWidth={1.5}
                  fill="url(#outputsGrad)"
                  name="Outputs"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-44 flex items-center justify-center text-white/40 font-mono text-xs">
              No health data available
            </div>
          )}
        </div>
      </div>

      {/* Recent outputs */}
      <div className="mt-6 pt-5 border-t border-white/[0.06]">
        <div className="font-mono text-[9px] text-white/40 uppercase tracking-widest mb-3">
          Recent Outputs
        </div>
        {outputs && outputs.length > 0 ? (
          <div className="space-y-2">
            {outputs.map((output: AgentOutput) => (
              <div
                key={output.id}
                className="flex items-start gap-3 bg-white/[0.02] rounded-lg px-3 py-2.5"
              >
                <Badge
                  variant={severityVariant[output.severity] || 'default'}
                  className="shrink-0 mt-0.5"
                >
                  {output.severity}
                </Badge>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[11px] text-white/70 line-clamp-2">
                    {output.summary}
                  </div>
                </div>
                <div className="font-mono text-[9px] text-white/50 shrink-0">
                  {relativeTime(output.created_at)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-white/40 font-mono text-[11px]">No recent outputs</div>
        )}
      </div>

      {/* Phase 5.5 — module declarations (budget, supervision,
          reads/writes, output types). Surfaces the AgentModule's
          declared fields so operators can compare intent vs actual. */}
      <div className="mt-4">
        <AgentDeclarationsPanel agentId={agent.name} />
      </div>
    </Card>
  );
}

function DetailRow({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[10px] text-white/40 uppercase tracking-wider">{label}</span>
      {children ?? <span className="font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{value}</span>}
    </div>
  );
}

// ─── Pipeline Automation Strip ──────────────────────────────────────

function trendArrow(dir: string): string {
  if (dir === 'down') return '↓';
  if (dir === 'up') return '↑';
  if (dir === 'flat') return '→';
  return '';
}

function trendColor(dir: string): string {
  if (dir === 'down') return 'var(--sev-info)';
  if (dir === 'up') return 'var(--sev-critical)';
  if (dir === 'flat') return 'var(--sev-medium)';
  return 'var(--text-muted)';
}

function trendBorderColor(dir: string): string {
  if (dir === 'down') return 'var(--sev-info-border)';
  if (dir === 'up') return 'var(--sev-critical-border)';
  if (dir === 'flat') return 'var(--sev-medium-border)';
  return 'var(--border-base)';
}

function agentStatusLabel(status: string): 'active' | 'failed' | 'degraded' | 'inactive' {
  if (status === 'active') return 'active';
  if (status === 'error') return 'failed';
  if (status === 'degraded') return 'degraded';
  return 'inactive';
}

/**
 * Trigger a GeoIP refresh from the Pipeline Automation tile.
 * Two affordances:
 *   - "Refresh" : poll MaxMind and re-import IFF a new release shipped
 *   - "Force"   : bypass the skip-if-current guard (after schema
 *                 changes, partial loads, or initial bootstrap when
 *                 source_version is null and we still want a load)
 *
 * Gated to the geoip pipeline only — other tiles don't have a
 * meaningful "trigger now" action because they're driven by feed
 * cadence, not on-demand work.
 */
function GeoipRefreshAction() {
  const refresh = useGeoipRefresh();
  const onClick = (forceReload: boolean) => {
    if (refresh.isPending) return;
    refresh.mutate({ forceReload });
  };
  const label = refresh.isPending
    ? 'Triggering…'
    : refresh.isSuccess
      ? 'Dispatched ✓'
      : refresh.isError
        ? 'Failed — retry'
        : 'Refresh';
  return (
    <div className="mt-2 pt-2 border-t border-white/[0.04] flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onClick(false)}
        disabled={refresh.isPending}
        className="font-mono text-[9px] px-2 py-1 rounded transition-colors hover:bg-white/[0.08] disabled:opacity-50"
        style={{
          color: 'var(--amber)',
          border: '1px solid rgba(229,168,50,0.30)',
          background: 'rgba(229,168,50,0.06)',
        }}
        title="Poll MaxMind, re-import only if a new release shipped"
      >
        {label}
      </button>
      <button
        type="button"
        onClick={() => onClick(true)}
        disabled={refresh.isPending}
        className="font-mono text-[9px] px-2 py-1 rounded transition-colors hover:bg-white/[0.08] disabled:opacity-50"
        style={{
          color: 'var(--text-secondary)',
          border: '1px solid var(--border-base)',
        }}
        title="Force re-import even if the live data already matches MaxMind's latest release"
      >
        Force
      </button>
      {refresh.isError && (
        <span
          className="font-mono text-[9px] truncate"
          style={{ color: 'var(--sev-critical)' }}
          title={refresh.error instanceof Error ? refresh.error.message : String(refresh.error)}
        >
          {refresh.error instanceof Error ? refresh.error.message : 'error'}
        </span>
      )}
    </div>
  );
}

function PipelineStrip({ agents }: { agents: Agent[] }) {
  const { data: pipelines } = usePipelineStatus(agents);

  const items = Array.isArray(pipelines) ? pipelines : [];

  if (items.length === 0) {
    return (
      <Card style={{ padding: '16px' }}>
        <div className="section-label font-mono font-bold mb-3">Pipeline Automation</div>
        <div className="font-mono text-[10px] text-white/30">Loading pipeline data...</div>
      </Card>
    );
  }

  return (
    <Card style={{ padding: '16px' }}>
      <div className="section-label font-mono font-bold mb-3">Pipeline Automation</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {items.map((p: PipelineEntry) => {
          const agentData = agents.find(a => a.name === p.agent);
          const agentStatus = agentData?.status ?? p.agent_last_status ?? 'idle';
          const borderColor = p.count === 0
            ? 'var(--border-base)'
            : trendBorderColor(p.trend_direction);
          const topBorderColor = p.count === 0
            ? 'var(--border-base)'
            : trendColor(p.trend_direction);

          return (
            <div
              key={p.id}
              className="rounded-lg overflow-hidden"
              style={{
                background: 'rgba(22,30,48,0.50)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: `1px solid ${borderColor}`,
                borderTop: `3px solid ${topBorderColor}`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 4px 24px rgba(0,0,0,0.40)',
              }}
            >
              <div className="p-3">
                {/* Header: label + agent badge */}
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
                    {p.label}
                  </span>
                  <Badge
                    status={agentStatusLabel(agentStatus)}
                    label={p.agent}
                    size="xs"
                    pulse={agentStatus === 'active'}
                  />
                </div>

                {/* Count + trend */}
                <div className="flex items-baseline gap-2 mb-1.5">
                  <span
                    className="font-display text-lg font-bold"
                    style={{ color: 'var(--text-primary)', lineHeight: 1 }}
                  >
                    {p.count.toLocaleString()}
                  </span>
                  {p.trend !== null && p.trend !== 0 && (
                    <span
                      className="font-mono text-[10px] font-bold"
                      style={{ color: trendColor(p.trend_direction) }}
                    >
                      {trendArrow(p.trend_direction)} {Math.abs(p.trend).toLocaleString()}
                    </span>
                  )}
                  {p.trend === 0 && (
                    <span className="font-mono text-[9px]" style={{ color: 'var(--sev-medium)' }}>
                      → steady
                    </span>
                  )}
                </div>

                {/* Schedule + last run */}
                <div className="font-mono text-[8px] space-y-0.5" style={{ color: 'var(--text-muted)' }}>
                  <div className="uppercase tracking-wider">{p.schedule}</div>
                  {p.agent_last_run_at && (
                    <div>
                      {relativeTime(p.agent_last_run_at)}
                      {p.agent_records_processed != null && p.agent_records_processed > 0 && (
                        <> · {p.agent_records_processed} rec</>
                      )}
                    </div>
                  )}
                </div>

                {/* External endpoints — DNS resolvers, third-party APIs.
                    Hidden when the pipeline has no off-platform deps. */}
                {p.endpoints && p.endpoints.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-white/[0.04] flex flex-wrap gap-1">
                    {p.endpoints.map((e) => (
                      <a
                        key={e.url}
                        href={e.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[8px] px-1.5 py-0.5 rounded transition-colors hover:bg-white/[0.05]"
                        style={{
                          color: 'var(--text-tertiary)',
                          border: '1px solid var(--border-base)',
                        }}
                        title={e.url}
                      >
                        {e.name}
                      </a>
                    ))}
                  </div>
                )}

                {/* Per-tile actions. Currently scoped to the geoip
                    pipeline because it's the only one with a
                    meaningful on-demand trigger; other tiles run
                    on feed cadence. */}
                {p.id === 'geoip' && <GeoipRefreshAction />}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Group section header ──────────────────────────────────────────
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="font-mono text-[10px] font-bold uppercase tracking-[0.22em]"
        style={{ color: 'var(--text-secondary)' }}
      >
        {label}
      </span>
      <div
        className="flex-1 h-px"
        style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.10), transparent)' }}
      />
      <span
        className="font-mono text-[10px]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {count}
      </span>
    </div>
  );
}

// ─── Monitor View (existing content, wrapped) ─────────────────
function MonitorView() {
  const { data: agents } = useAgents();
  // useNavigate previously used for the architect detail click-through;
  // the agent retired 2026-04-29 and no other navigation is needed here.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const flightControl = agents?.find(a => a.name === 'flight_control') ?? null;

  // Map each grouped agent id to its live Agent payload, dropping
  // any agent that hasn't surfaced from the API yet.
  const groupedAgents = useMemo(() => {
    if (!agents) return [] as { group: AgentGroup; items: Agent[] }[];
    return AGENT_GROUPS.map(group => ({
      group,
      items: group.agentIds
        .map(id => agents.find(a => a.name === id))
        .filter((a): a is Agent => !!a),
    })).filter(g => g.items.length > 0);
  }, [agents]);

  // Anything coming back from the API that isn't in a known group
  // (new agent shipped before metadata catches up) — surface it under
  // a fallback "Unclassified" group instead of silently dropping it.
  const unclassifiedAgents = useMemo(() => {
    if (!agents) return [];
    const known = new Set<string>([
      'flight_control',
      ...AGENT_GROUPS.flatMap(g => g.agentIds),
    ]);
    return agents.filter(a => !known.has(a.name));
  }, [agents]);

  const operational = agents?.filter(a => a.status !== 'error').length ?? 0;
  const total = agents?.length ?? 0;
  const totalJobs = agents?.reduce((sum, a) => sum + a.jobs_24h, 0) ?? 0;
  const totalOutputs = agents?.reduce((sum, a) => sum + a.outputs_24h, 0) ?? 0;
  const totalErrors = agents?.reduce((sum, a) => sum + a.error_count_24h, 0) ?? 0;

  const selectedAgentData = agents?.find(a => a.name === selectedAgent) ?? null;

  function handleSelect(agentName: string) {
    // (architect's dedicated detail view click-through retired
    //  2026-04-29 along with the agent itself; the route still
    //  exists at /agents/architect for forensic access but is no
    //  longer reachable from the Agents page.)
    setSelectedAgent(prev => (prev === agentName ? null : agentName));
  }

  return (
    <div className="space-y-6">
      {/* TOP STATS BAR */}
      <StatGrid cols={4}>
        <StatCard label="Agents Operational" value={`${operational}/${total}`} accentColor="var(--green)" />
        <StatCard label="Jobs (24h)" value={totalJobs.toLocaleString()} />
        <StatCard label="Outputs (24h)" value={totalOutputs.toLocaleString()} />
        <StatCard
          label="Errors (24h)"
          value={totalErrors}
          accentColor={totalErrors > 0 ? (totalErrors >= 5 ? 'var(--red)' : 'var(--sev-high)') : undefined}
        />
      </StatGrid>

      {agents && agents.length > 0 ? (
        <div className="space-y-6">
          <div>
            <SectionLabel className="mb-3">Squadron Status</SectionLabel>

            {/* Flight Control — full-width supervisor card + its panel */}
            {flightControl && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <FlightControlCard
                  agent={flightControl}
                  allAgents={agents}
                  isSelected={selectedAgent === 'flight_control'}
                  onSelect={() =>
                    setSelectedAgent(prev => prev === 'flight_control' ? null : 'flight_control')
                  }
                />
                {selectedAgent === 'flight_control' && selectedAgentData && (
                  <AgentDetailPanel agent={selectedAgentData} />
                )}
              </div>
            )}
          </div>

          {/* Grouped agents — each group gets its own header + grid so
              the inline detail panel stays scoped to its own group's row. */}
          {groupedAgents.map(({ group, items }) => (
            <div key={group.id} className="space-y-3">
              <GroupHeader label={group.label} count={items.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {items.map(agent => (
                  <Fragment key={agent.agent_id}>
                    <AgentCard
                      agent={agent}
                      isSelected={selectedAgent === agent.name}
                      onSelect={() => handleSelect(agent.name)}
                    />
                    {selectedAgent === agent.name && selectedAgentData && (
                      <AgentDetailPanel agent={selectedAgentData} />
                    )}
                  </Fragment>
                ))}
              </div>
            </div>
          ))}

          {/* Fallback bucket for agents the API knows about but
              metadata hasn't grouped yet — keeps them visible. */}
          {unclassifiedAgents.length > 0 && (
            <div className="space-y-3">
              <GroupHeader label="Unclassified" count={unclassifiedAgents.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {unclassifiedAgents.map(agent => (
                  <Fragment key={agent.agent_id}>
                    <AgentCard
                      agent={agent}
                      isSelected={selectedAgent === agent.name}
                      onSelect={() => handleSelect(agent.name)}
                    />
                    {selectedAgent === agent.name && selectedAgentData && (
                      <AgentDetailPanel agent={selectedAgentData} />
                    )}
                  </Fragment>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          icon={<Bot />}
          title="Squadron offline"
          subtitle="No AI agents are currently registered. Check your worker deployment and agent configuration."
          variant="error"
        />
      )}

      {/* PIPELINE AUTOMATION STRIP */}
      {agents && agents.length > 0 && (
        <PipelineStrip agents={agents} />
      )}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────
export function Agents() {
  const { data: agents = [], isLoading } = useAgents();
  const [activeTab, setActiveTab] = useState<AgentTab>('MONITOR');

  if (isLoading) return <CardGridLoader count={6} />;

  return (
    <div className="animate-fade-in space-y-6">
      {/* Page header with LIVE badge */}
      <PageHeader
        title="AI Agent Operations"
        subtitle="AI agent mesh — threat intelligence automation"
        actions={
          <div className="flex items-center gap-3">
            <PendingApprovalsLink />
            <LiveIndicator />
          </div>
        }
      />

      {/* Tab switcher */}
      <Tabs
        tabs={[
          { id: 'MONITOR', label: 'Monitor' },
          { id: 'HISTORY', label: 'History' },
          { id: 'CONFIG',  label: 'Config'  },
        ]}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as AgentTab)}
        variant="pills"
      />

      {/* Tab panels */}
      {activeTab === 'MONITOR' && <MonitorView />}
      {activeTab === 'HISTORY' && <HistoryView />}
      {activeTab === 'CONFIG' && <ConfigView />}
    </div>
  );
}
