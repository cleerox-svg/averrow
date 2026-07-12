// AI Spend — the single cost view on the Cost & Budget tab of /admin.
//
// v2's AiSpendSection is one Card with 4 KPI tiles + a daily-cost
// bar chart + a flat per-agent table. v3 rebuilt the per-agent
// breakdown as a ranked card grid but left the standalone
// "Cost Optimization" tab rendering the SAME three dominant agents'
// cost with a SECOND window toggle — visible duplication (Tier 4).
//
// This version folds Cost Optimization in:
//   - Single window toggle (24h/7d/30d) drives KPI tiles AND the
//     per-agent grid (now sourced from `by_agent[window]`, the
//     per-window top-20 the backend added alongside the legacy
//     `by_agent_30d`).
//   - Each agent's expand/detail panel adds `out_in_ratio`
//     (output/input tokens, pre-computed server-side) — the
//     efficiency indicator the old Cost Optimization view tracked
//     per focus-agent.
//   - A collapsed-by-default "Cost-reduction levers" sub-section
//     holds the cartographer 30d trend + the static lever roster —
//     detail operators want occasionally, not on every visit.
//
// Same hook (useAiSpend) → same data → same backend cost. Backend:
// handleMetricsAiSpend now returns the superset that absorbed the
// retired-from-the-frontend ai-cost-optimization shape (see
// packages/trust-radar/src/handlers/admin.ts).

import { Fragment, useState } from 'react';
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip, Legend,
  CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useAiSpend } from '@/hooks/useMetrics';
import type { AiSpendPayload, AiSpendByAgentWindowed } from '@/hooks/useMetrics';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';

type Window = '24h' | '7d' | '30d';
const WINDOWS: Window[] = ['24h', '7d', '30d'];

export function AiSpend() {
  const { data, isLoading, isError } = useAiSpend();
  const [windowSel, setWindowSel] = useState<Window>('24h');

  if (isError) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load AI spend. Try again in a moment.
        </p>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading AI spend…
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Header windowSel={windowSel} onWindowChange={setWindowSel} />
      <Totals data={data} window={windowSel} />
      <DailyChart data={data} />
      <PerAgentGrid data={data} window={windowSel} />
      <CostReductionLevers data={data} />
    </div>
  );
}

function Header({ windowSel, onWindowChange }: { windowSel: Window; onWindowChange: (w: Window) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold"
        style={{ color: 'var(--text-primary)' }}
      >
        Window
      </span>
      <div
        role="radiogroup"
        aria-label="Spend window"
        className="inline-flex rounded-md overflow-hidden"
        style={{
          border:     '1px solid var(--border-base)',
          background: 'var(--bg-input)',
        }}
      >
        {WINDOWS.map(w => {
          const active = w === windowSel;
          return (
            <button
              key={w}
              role="radio"
              aria-checked={active}
              onClick={() => onWindowChange(w)}
              className="px-2.5 py-1 font-mono text-[10px] tracking-[0.18em] uppercase transition-colors"
              style={{
                background: active ? 'var(--amber)' : 'transparent',
                color:      active ? '#0A0F1C' : 'var(--text-secondary)',
                fontWeight: active ? 600 : 500,
              }}
            >
              {w}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Top KPI tiles ───────────────────────────────────────────────
function Totals({ data, window }: { data: AiSpendPayload; window: Window }) {
  const w = data.windows[window];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Tile label="Total cost"    value={`$${w.cost_usd.toFixed(2)}`} accent="amber" />
      <Tile label="Calls"         value={w.calls.toLocaleString()} />
      <Tile label="Input tokens"  value={formatBig(w.input_tokens)} />
      <Tile label="Output tokens" value={formatBig(w.output_tokens)} />
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: 'amber' }) {
  return (
    <Card variant="elevated" className="p-4">
      <div
        className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {label}
      </div>
      <div
        className="font-display text-2xl font-bold"
        style={{ color: accent === 'amber' ? 'var(--amber)' : 'var(--text-primary)' }}
      >
        {value}
      </div>
    </Card>
  );
}

// ─── Daily cost bar chart (30d summary, all agents) ──────────────
function DailyChart({ data }: { data: AiSpendPayload }) {
  const chartData = data.daily_30d.map(d => ({
    day:   d.day.slice(5),       // MM-DD
    cost:  Number(d.cost_usd.toFixed(2)),
    calls: d.calls,
  }));

  if (chartData.length === 0) {
    return (
      <Card variant="elevated" className="p-4">
        <SectionHeader title="Daily cost · last 30d" />
        <p className="font-mono text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
          No spend recorded in the last 30 days.
        </p>
      </Card>
    );
  }

  return (
    <Card variant="elevated" className="p-4">
      <SectionHeader title="Daily cost · last 30d" />
      <div className="mt-2">
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="ai-spend-bar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stopColor="var(--amber)" stopOpacity={0.9} />
                <stop offset="100%" stopColor="var(--amber)" stopOpacity={0.4} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="day"
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
              formatter={(v, name) => {
                const num = typeof v === 'number' ? v : Number(v);
                return name === 'cost'
                  ? [`$${num.toFixed(2)}`, 'Cost']
                  : [num.toLocaleString(), String(name)];
              }}
            />
            <Bar dataKey="cost" fill="url(#ai-spend-bar)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ─── Per-agent grid — driven by the selected window ──────────────
function PerAgentGrid({ data, window }: { data: AiSpendPayload; window: Window }) {
  const agents = data.by_agent[window];
  const total = agents.reduce((s, a) => s + a.cost_usd, 0);
  const [selected, setSelected] = useState<string | null>(null);

  if (agents.length === 0) {
    return (
      <div className="space-y-2">
        <SectionHeader title={`Per agent · ${window} cost`} />
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No agent spend recorded in this window.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeader title={`Per agent · ${window} cost`} count={agents.length} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {agents.map((a, i) => {
          const pct = total > 0 ? (a.cost_usd / total) * 100 : 0;
          const isSel = selected === a.agent_id;
          return (
            <Fragment key={a.agent_id}>
              <AgentSpendCard
                rank={i + 1}
                agent={a}
                pctOfTotal={pct}
                isSelected={isSel}
                onSelect={() => setSelected(prev => prev === a.agent_id ? null : a.agent_id)}
              />
              {isSel && <AgentSpendDetail agent={a} pctOfTotal={pct} />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

type Tier = 'critical' | 'high' | 'green';
function tierFor(pct: number): Tier {
  if (pct >= 30) return 'critical';
  if (pct >= 15) return 'high';
  return 'green';
}
function tierColor(t: Tier): string {
  if (t === 'critical') return 'var(--sev-critical)';
  if (t === 'high')     return 'var(--sev-high)';
  return 'var(--green)';
}

function AgentSpendCard({
  rank, agent, pctOfTotal, isSelected, onSelect,
}: {
  rank:       number;
  agent:      AiSpendByAgentWindowed;
  pctOfTotal: number;
  isSelected: boolean;
  onSelect:   () => void;
}) {
  const tier = tierFor(pctOfTotal);
  const meta = AGENT_METADATA[agent.agent_id as AgentId];
  const variant: 'elevated' | 'critical' = tier === 'critical' ? 'critical' : 'elevated';
  const barColor = tierColor(tier);
  const tint = meta?.color ?? 'var(--blue)';

  return (
    <Card
      variant={variant}
      className="p-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      {/* Header: rank + icon + name + chevron */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className="font-mono text-[10px] font-bold w-5 h-5 rounded grid place-items-center flex-shrink-0"
          style={{ background: 'var(--bg-input)', color: 'var(--text-tertiary)' }}
        >
          {rank}
        </span>
        <span style={{ color: tint }} className="flex-shrink-0">
          <AgentIcon agent={agent.agent_id} size={20} />
        </span>
        <span
          className="font-mono text-[12px] font-bold uppercase tracking-wide truncate flex-1"
          style={{ color: 'var(--text-primary)' }}
        >
          {meta?.displayName ?? agent.agent_id}
        </span>
        {tier === 'critical' && <Badge severity="critical">Top</Badge>}
        <ChevronDown
          size={12}
          style={{
            color:      'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </div>

      {/* Big cost + % */}
      <div className="flex items-end justify-between gap-2 mb-2">
        <span
          className="font-display text-xl font-bold"
          style={{ color: 'var(--text-primary)', lineHeight: 1 }}
        >
          ${agent.cost_usd.toFixed(2)}
        </span>
        <span
          className="font-mono text-[10px] font-bold"
          style={{ color: barColor }}
        >
          {pctOfTotal.toFixed(0)}% of total
        </span>
      </div>

      {/* % of total bar */}
      <div
        className="rounded-full overflow-hidden mb-2"
        style={{ height: 3, background: 'var(--border-base)' }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, pctOfTotal)}%`,
            background: barColor,
          }}
        />
      </div>

      {/* Mini-stats */}
      <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
        <Mini label="CALLS"  value={agent.calls.toLocaleString()} />
        <Mini label="IN"     value={formatBig(agent.input_tokens)} />
        <Mini label="OUT"    value={formatBig(agent.output_tokens)} />
      </div>
    </Card>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function AgentSpendDetail({ agent, pctOfTotal }: { agent: AiSpendByAgentWindowed; pctOfTotal: number }) {
  const meta = AGENT_METADATA[agent.agent_id as AgentId];
  // Per-call cost. Tells operators if a single agent is unusually
  // expensive per invocation (vs just running often).
  const costPerCall = agent.calls > 0 ? agent.cost_usd / agent.calls : 0;
  const tokensPerCall = agent.calls > 0 ? (agent.input_tokens + agent.output_tokens) / agent.calls : 0;
  // Output:input token ratio, pre-computed server-side (out_in_ratio).
  // Near/above 1.0 means output tokens dominate cost — the indicator
  // the old Cost Optimization tab tracked per focus-agent (Lever #1
  // targets < 0.5 on cartographer).
  const ratioTier = agent.out_in_ratio >= 0.9 ? 'critical'
                   : agent.out_in_ratio >= 0.5 ? 'high'
                   : 'green';
  const ratioColor = ratioTier === 'critical' ? 'var(--sev-critical)'
                    : ratioTier === 'high'     ? 'var(--sev-high)'
                    : 'var(--green)';

  return (
    <Card variant="elevated" className="p-4 col-span-full">
      {meta?.subtitle && (
        <div className="mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-base)' }}>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
            What it does
          </div>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {meta.subtitle}
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Cost"            value={`$${agent.cost_usd.toFixed(2)}`} />
        <Stat label="% of total"      value={`${pctOfTotal.toFixed(1)}%`} />
        <Stat label="Calls"           value={agent.calls.toLocaleString()} />
        <Stat label="Cost / call"     value={`$${costPerCall.toFixed(4)}`} />
        <Stat label="Input tokens"    value={agent.input_tokens.toLocaleString()} />
        <Stat label="Output tokens"   value={agent.output_tokens.toLocaleString()} />
        <Stat label="Avg tokens/call" value={tokensPerCall.toFixed(0)} />
        <Stat label="Out:in ratio"    value={agent.out_in_ratio.toFixed(2)} valueColor={ratioColor} />
      </div>
    </Card>
  );
}

// ─── Cost-reduction levers — collapsed by default ────────────────
//
// Sub-section that absorbed the standalone Cost Optimization tab:
// the cartographer 30d trend + the (static, completed-plan) lever
// roster. Collapsed by default since this is detail operators want
// occasionally, not on every visit to Cost & Budget.
function CostReductionLevers({ data }: { data: AiSpendPayload }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card padding={0}>
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-3 px-4 py-3"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <span
          className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold"
          style={{ color: 'var(--text-primary)' }}
        >
          Cost-reduction levers
        </span>
        {expanded
          ? <ChevronUp size={14} style={{ color: 'var(--text-secondary)' }} />
          : <ChevronDown size={14} style={{ color: 'var(--text-secondary)' }} />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-6">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Tracks the completed AI cost-reduction plan for the three focus agents
            (cartographer, analyst, sentinel) that account for ~97% of platform AI spend —
            watch <strong>out:in ratio</strong> and <strong>cost/call</strong> in the grid above.
          </p>
          <CartographerTrend data={data} />
          <LeverRoster levers={AI_COST_OPTIMIZATION_LEVERS} />
        </div>
      )}
    </Card>
  );
}

// ─── Cartographer 30d trend ──────────────────────────────────────
function CartographerTrend({ data }: { data: AiSpendPayload }) {
  const chartData = data.cartographer_daily_30d.map((d) => ({
    day:        d.day.slice(5),
    cost:       Number(d.cost_usd.toFixed(4)),
    calls:      d.calls,
    out_in:     d.input_tokens > 0 ? Number((d.output_tokens / d.input_tokens).toFixed(2)) : 0,
    cost_per_call: d.calls > 0 ? Number((d.cost_usd / d.calls).toFixed(5)) : 0,
  }));

  if (chartData.length === 0) {
    return (
      <Card variant="elevated" className="p-4">
        <SectionHeader title="Cartographer · 30d trend" />
        <p className="font-mono text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
          No cartographer spend recorded in the last 30 days.
        </p>
      </Card>
    );
  }

  return (
    <Card variant="elevated" className="p-4">
      <SectionHeader title="Cartographer · 30d trend" />
      <div
        className="font-mono text-[9px] mt-1 mb-3"
        style={{ color: 'var(--text-muted)' }}
      >
        Watch <strong>out:in ratio</strong> drop as Lever&nbsp;#1 lands,
        <strong> calls</strong> drop as Lever&nbsp;#1b lands,
        and <strong>cost/call</strong> halve since Lever&nbsp;#6 shipped.
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 3" stroke="var(--border-base)" vertical={false} />
          <defs>
            <linearGradient id="cart-cost-bar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="var(--amber)" stopOpacity={0.9} />
              <stop offset="100%" stopColor="var(--amber)" stopOpacity={0.4} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="day"
            tick={{ fontSize: 9, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 9, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 9, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
            axisLine={false}
            tickLine={false}
            width={32}
            domain={[0, 'auto']}
          />
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
            formatter={(v, name) => {
              const num = typeof v === 'number' ? v : Number(v);
              if (name === 'cost')          return [`$${num.toFixed(2)}`, 'Cost'];
              if (name === 'calls')         return [num.toLocaleString(), 'Calls'];
              if (name === 'out_in')        return [num.toFixed(2), 'Out:In'];
              if (name === 'cost_per_call') return [`$${num.toFixed(5)}`, 'Cost/call'];
              return [String(num), String(name)];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}
            iconSize={8}
          />
          <Bar  yAxisId="left"  dataKey="cost"   fill="url(#cart-cost-bar)" radius={[2, 2, 0, 0]} />
          <Line yAxisId="right" dataKey="out_in" stroke="var(--sev-critical)" strokeWidth={1.5} dot={false} />
          <Line yAxisId="right" dataKey="cost_per_call" stroke="var(--blue)" strokeWidth={1.5} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ─── Lever roster (static — completed cost-reduction plan) ──────
type LeverStatus = 'planned' | 'in_progress' | 'deployed';

interface CostLever {
  id: string;
  title: string;
  target_agent: string;
  status: LeverStatus;
  estimated_savings_usd_per_year: number;
  deployed_at: string | null;
  indicator: string;
}

const AI_COST_OPTIMIZATION_LEVERS: CostLever[] = [
  { id: "lever_1",  title: "Cartographer scoreProvider output-schema tightening", target_agent: "cartographer", status: "deployed", estimated_savings_usd_per_year: 850, deployed_at: "2026-05-23", indicator: "out:in ratio drops below 0.5 on cartographer" },
  { id: "lever_1b", title: "Cartographer in-prompt batching (N providers/call)", target_agent: "cartographer", status: "deployed", estimated_savings_usd_per_year: 200, deployed_at: "2026-05-23", indicator: "calls/day on cartographer drop without record volume changing" },
  { id: "lever_2",  title: "Analyst keyword pre-match expansion", target_agent: "analyst", status: "deployed", estimated_savings_usd_per_year: 250, deployed_at: "2026-05-23", indicator: "calls/day on analyst drop" },
  { id: "lever_3",  title: "Sentinel sibling-domain deduplication + tighter response JSON", target_agent: "sentinel", status: "deployed", estimated_savings_usd_per_year: 125, deployed_at: "2026-05-23", indicator: "calls/day on sentinel drop; out:in ratio drops" },
  { id: "lever_4",  title: "Add cache_control plumbing to lib/anthropic.ts", target_agent: "(infra)", status: "deployed", estimated_savings_usd_per_year: 0, deployed_at: "2026-05-23", indicator: "infra-only — enables future levers" },
  { id: "lever_6",  title: "Cartographer Message Batches API (50% async discount)", target_agent: "cartographer", status: "deployed", estimated_savings_usd_per_year: 675, deployed_at: "2026-05-23", indicator: "cost/call on cartographer drops ~50% post-cutover" },
];

function LeverRoster({ levers }: { levers: CostLever[] }) {
  const totalSavings = levers.reduce((s, l) => s + l.estimated_savings_usd_per_year, 0);
  const deployedCount = levers.filter((l) => l.status === 'deployed').length;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <span
          className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold"
          style={{ color: 'var(--text-primary)' }}
        >
          Lever roster
        </span>
        <span
          className="font-mono text-[10px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {deployedCount}/{levers.length} deployed · est. ${totalSavings.toFixed(0)}/yr
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {levers.map((l) => (
          <LeverCard key={l.id} lever={l} />
        ))}
      </div>
    </div>
  );
}

function LeverCard({ lever }: { lever: CostLever }) {
  const statusColor = lever.status === 'deployed'    ? 'var(--green)'
                    : lever.status === 'in_progress' ? 'var(--amber)'
                    :                                  'var(--text-muted)';
  const statusBg    = lever.status === 'deployed'    ? 'var(--sev-low-bg)'
                    : lever.status === 'in_progress' ? 'var(--sev-medium-bg)'
                    :                                  'var(--bg-input)';

  return (
    <Card variant="elevated" className="p-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span
          className="font-mono text-[11px] font-bold uppercase tracking-wide"
          style={{ color: 'var(--text-primary)' }}
        >
          {lever.id.replace('_', ' ')} · {lever.title}
        </span>
        <span
          className="font-mono text-[9px] tracking-[0.15em] uppercase px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: statusColor, background: statusBg }}
        >
          {lever.status.replace('_', ' ')}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Stat label="Target agent" value={lever.target_agent} />
        <Stat label="Est. savings" value={`$${lever.estimated_savings_usd_per_year}/yr`} />
      </div>
      <div
        className="font-mono text-[9px] tracking-[0.15em] uppercase mb-1"
        style={{ color: 'var(--text-muted)' }}
      >
        Indicator
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {lever.indicator}
      </p>
      {lever.deployed_at && (
        <div
          className="font-mono text-[9px] mt-2"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Deployed {lever.deployed_at.slice(0, 10)}
        </div>
      )}
    </Card>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────
function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <span
        className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold"
        style={{ color: 'var(--text-primary)' }}
      >
        {title}
      </span>
      {count != null && (
        <span
          className="font-mono text-[10px] px-2 py-0.5 rounded"
          style={{
            background: 'var(--bg-input)',
            color:      'var(--text-secondary)',
            border:     '1px solid var(--border-base)',
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-base font-mono" style={{ color: valueColor ?? 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function formatBig(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}
