// AI Spend, v3 treatment for /admin/metrics.
//
// v2's AiSpendSection is one Card with 4 KPI tiles + a daily-cost
// bar chart + a flat per-agent table. The table is the part most
// operators scan first ("which agent is the biggest spender right
// now?") — but it reads as a wall of numbers.
//
// v3 keeps the window toggle + KPI tiles at the top, promotes the
// 30-day daily bar chart to a standalone summary card, and rebuilds
// the per-agent breakdown as a ranked card grid (mirrors the
// agents-v3 / D1Budget-v3 pattern). Each agent card has:
//   - AgentIcon + display name + cost-tier badge
//   - Big cost number for the selected window
//   - % of total spend bar
//   - Calls + I/O token mini-stats
//   - Click to expand inline for the breakdown table
//
// Same hook (useAiSpend) → same data → same backend cost.

import { Fragment, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { ChevronDown } from 'lucide-react';
import { useAiSpend } from '@/hooks/useMetrics';
import type { AiSpendPayload, AiSpendByAgent } from '@/hooks/useMetrics';
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
      <PerAgentGrid data={data} />
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

// ─── Daily cost bar chart (30d summary) ──────────────────────────
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

// ─── Per-agent grid ──────────────────────────────────────────────
function PerAgentGrid({ data }: { data: AiSpendPayload }) {
  const agents = data.by_agent_30d;
  const total = agents.reduce((s, a) => s + a.cost_usd, 0);
  const [selected, setSelected] = useState<string | null>(null);

  if (agents.length === 0) {
    return (
      <div className="space-y-2">
        <SectionHeader title="Per agent · 30d cost" />
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No agent spend recorded in the 30-day window.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeader title="Per agent · 30d cost" count={agents.length} />
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
  agent:      AiSpendByAgent;
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

function AgentSpendDetail({ agent, pctOfTotal }: { agent: AiSpendByAgent; pctOfTotal: number }) {
  const meta = AGENT_METADATA[agent.agent_id as AgentId];
  // Per-call cost. Tells operators if a single agent is unusually
  // expensive per invocation (vs just running often).
  const costPerCall = agent.calls > 0 ? agent.cost_usd / agent.calls : 0;
  const tokensPerCall = agent.calls > 0 ? (agent.input_tokens + agent.output_tokens) / agent.calls : 0;

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
        <Stat label="30d cost"        value={`$${agent.cost_usd.toFixed(2)}`} />
        <Stat label="% of total"      value={`${pctOfTotal.toFixed(1)}%`} />
        <Stat label="Calls · 30d"     value={agent.calls.toLocaleString()} />
        <Stat label="Cost / call"     value={`$${costPerCall.toFixed(4)}`} />
        <Stat label="Input tokens"    value={agent.input_tokens.toLocaleString()} />
        <Stat label="Output tokens"   value={agent.output_tokens.toLocaleString()} />
        <Stat label="Avg tokens/call" value={tokensPerCall.toFixed(0)} />
        <Stat label="Daily avg"       value={`$${(agent.cost_usd / 30).toFixed(3)}`} />
      </div>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-base font-mono" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function formatBig(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}
