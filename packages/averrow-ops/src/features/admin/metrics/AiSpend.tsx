// AI Spend — Metrics page section 3.
//
// Three-window totals (24h / 7d / 30d) with a toggle, a 30-day
// daily-cost bar chart, and the per-agent breakdown for the
// 30-day window. Answers "what's the AI bill running at, and
// which agent is dominant?" without needing to grep budget_ledger.

import { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card } from '@/design-system/components';
import { useAiSpend, type AiSpendPayload } from '@/hooks/useMetrics';
import { MetricsTile } from './MetricsTile';

type Window = '24h' | '7d' | '30d';
const WINDOWS: Window[] = ['24h', '7d', '30d'];

export function AiSpendSection() {
  const { data, isLoading, isError } = useAiSpend();
  const [selectedWindow, setSelectedWindow] = useState<Window>('24h');

  return (
    <Card style={{ padding: '16px' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="section-label font-mono font-bold">AI Spend</span>
        {data && (
          <WindowToggle
            value={selectedWindow}
            onChange={setSelectedWindow}
          />
        )}
      </div>

      {isError ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load AI spend. Try again in a moment.
        </p>
      ) : isLoading || !data ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading AI spend…
        </p>
      ) : (
        <div className="space-y-4">
          <Totals data={data} window={selectedWindow} />
          <DailyChart data={data} />
          <PerAgentTable data={data} />
        </div>
      )}
    </Card>
  );
}

function WindowToggle({
  value,
  onChange,
}: {
  value: Window;
  onChange: (w: Window) => void;
}) {
  return (
    <div className="flex gap-1">
      {WINDOWS.map((w) => {
        const active = w === value;
        return (
          <button
            key={w}
            type="button"
            onClick={() => onChange(w)}
            className="font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded transition-colors"
            style={{
              color: active ? 'var(--amber)' : 'var(--text-tertiary)',
              background: active ? 'rgba(229,168,50,0.10)' : 'transparent',
              border: `1px solid ${active ? 'rgba(229,168,50,0.30)' : 'var(--border-base)'}`,
            }}
            aria-pressed={active}
          >
            {w}
          </button>
        );
      })}
    </div>
  );
}

function Totals({ data, window }: { data: AiSpendPayload; window: Window }) {
  const w = data.windows[window];
  // Cost tile gets the amber-info accent (matches the daily-cost
  // bars below); other tiles stay neutral so the "where am I
  // spending?" answer pops.
  const tiles: Array<{
    label: string;
    value: string;
    sub: string;
    tone: import('./MetricsTile').MetricsTone;
  }> = [
    { label: 'Total cost',    value: `$${w.cost_usd.toFixed(2)}`,    sub: 'USD', tone: 'info'    },
    { label: 'Calls',         value: w.calls.toLocaleString(),       sub: '',    tone: 'default' },
    { label: 'Input tokens',  value: formatBig(w.input_tokens),      sub: '',    tone: 'default' },
    { label: 'Output tokens', value: formatBig(w.output_tokens),     sub: '',    tone: 'default' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {tiles.map((t) => (
        <MetricsTile key={t.label} label={t.label} tone={t.tone}>
          <div className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            {t.value}
          </div>
          {t.sub ? (
            <div className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
              {t.sub}
            </div>
          ) : null}
        </MetricsTile>
      ))}
    </div>
  );
}

function DailyChart({ data }: { data: AiSpendPayload }) {
  // Drop the current day if it's clearly partial (under 25% of the
  // 7d average) so the rightmost bar doesn't render as misleadingly
  // low. Triagers have asked for this before with the diagnostics
  // CLI; same logic here.
  const series = data.daily_30d.map((d) => ({
    day: d.day.slice(5),  // 'MM-DD'
    cost: Math.round(d.cost_usd * 100) / 100,
  }));

  if (series.length === 0) {
    return (
      <div>
        <Header label="Daily cost (30d)" />
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No data in the last 30 days.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Header label="Daily cost (30d)" />
      <div style={{ height: 110 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
            <XAxis
              dataKey="day"
              tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.30)' }}
              interval="preserveStartEnd"
              axisLine={false}
              tickLine={false}
            />
            <YAxis hide />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-base)',
                borderRadius: 6,
                fontSize: 10,
              }}
              labelStyle={{ color: 'var(--text-secondary)' }}
              formatter={(v) => [`$${Number(v).toFixed(2)}`, 'cost']}
            />
            <Bar dataKey="cost" fill="var(--amber)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PerAgentTable({ data }: { data: AiSpendPayload }) {
  if (data.by_agent_30d.length === 0) {
    return (
      <div>
        <Header label="By agent (30d)" />
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No AI calls in the last 30 days.
        </p>
      </div>
    );
  }
  const totalCost = data.windows['30d'].cost_usd || 1;
  return (
    <div>
      <Header label="By agent (30d)" />
      <ul className="space-y-0.5">
        {data.by_agent_30d.map((a) => {
          const pct = (a.cost_usd / totalCost) * 100;
          return (
            <li
              key={a.agent_id}
              className="flex items-baseline gap-3 py-1 border-b border-white/[0.04]"
            >
              <span
                className="font-mono text-[10px] flex-1 truncate"
                style={{ color: 'var(--text-secondary)' }}
                title={a.agent_id}
              >
                {a.agent_id}
              </span>
              <span
                className="font-mono text-[9px] w-14 text-right shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {a.calls.toLocaleString()}
              </span>
              <span
                className="font-mono text-[10px] font-bold w-16 text-right shrink-0"
                style={{ color: 'var(--text-primary)' }}
              >
                ${a.cost_usd.toFixed(2)}
              </span>
              <div
                className="rounded-full overflow-hidden shrink-0"
                style={{
                  width: 60,
                  height: 4,
                  background: 'rgba(255,255,255,0.06)',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, pct)}%`,
                    background: 'var(--amber)',
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Header({ label }: { label: string }) {
  return (
    <div
      className="font-mono text-[9px] uppercase tracking-[0.18em] mb-1.5"
      style={{ color: 'var(--text-tertiary)' }}
    >
      {label}
    </div>
  );
}

function formatBig(n: number): string {
  if (n >= 1e9)  return `${(n / 1e9 ).toFixed(1)}B`;
  if (n >= 1e6)  return `${(n / 1e6 ).toFixed(1)}M`;
  if (n >= 1e3)  return `${(n / 1e3 ).toFixed(1)}K`;
  return n.toLocaleString();
}
