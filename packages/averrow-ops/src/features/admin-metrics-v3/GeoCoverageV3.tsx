// Geo Coverage, v3 treatment for /admin/metrics-v3.
//
// v2's GeoCoverageSection wraps everything in one Card: 3-up
// window tiles, a daily trend area chart, and a flat exhausted-pile
// list. The exhausted pile is the operationally-actionable part
// ("which feed × threat-type is the cartographer giving up on?")
// but it reads as a wall of rows.
//
// v3 splits into three sections:
//   1. Window tiles (24h / 7d / 30d) — bigger v3 cards with
//      verdict badge + gauge bar.
//   2. Daily trend — promoted to its own card with an 80% target
//      reference line so the eye reads "are we above or below
//      target?" at a glance.
//   3. Exhausted pile — ranked card grid per (feed × threat_type),
//      tinted by share of total exhausted, click-to-expand for
//      remediation hints.
//
// Same useGeoCoverage hook → same data → same backend cost.

import { Fragment, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { ChevronDown } from 'lucide-react';
import { useGeoCoverage } from '@/hooks/useMetrics';
import type {
  GeoCoveragePayload, GeoCoverageWindow, GeoCoverageExhaustedByFeed,
} from '@/hooks/useMetrics';

export function GeoCoverageV3() {
  const { data, isLoading, isError } = useGeoCoverage();

  if (isError) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load geo coverage. Try again in a moment.
        </p>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading coverage…
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <CoverageWindows windows={data.windows} />
      <DailyTrend data={data} />
      <ExhaustedGrid data={data} />
    </div>
  );
}

// ─── Window coverage tiles ───────────────────────────────────────
function CoverageWindows({ windows }: { windows: GeoCoverageWindow[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {windows.map(w => <WindowTile key={w.window} window={w} />)}
    </div>
  );
}

type Tone = 'critical' | 'high' | 'green' | 'muted';
function coverageVerdict(pct: number | null): { tone: Tone; label: string; sev: 'critical' | 'high' | 'medium' | null } {
  if (pct == null) return { tone: 'muted', label: 'NO DATA', sev: 'medium' };
  if (pct >= 80)   return { tone: 'green', label: 'HEALTHY', sev: null };
  if (pct >= 50)   return { tone: 'high',  label: 'DEGRADED', sev: 'high' };
  return               { tone: 'critical', label: 'IMPAIRED', sev: 'critical' };
}
function toneColor(t: Tone): string {
  if (t === 'critical') return 'var(--sev-critical)';
  if (t === 'high')     return 'var(--sev-high)';
  if (t === 'green')    return 'var(--green)';
  return 'var(--text-muted)';
}

function WindowTile({ window: w }: { window: GeoCoverageWindow }) {
  const verdict = coverageVerdict(w.coverage_pct);
  const variant: 'elevated' | 'critical' = verdict.tone === 'critical' || verdict.tone === 'high' ? 'critical' : 'elevated';
  const bar = toneColor(verdict.tone);
  const pct = Math.min(100, Math.max(0, w.coverage_pct ?? 0));

  return (
    <Card variant={variant} className="p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
          {w.window}
        </span>
        {verdict.sev && <Badge severity={verdict.sev}>{verdict.label}</Badge>}
        {!verdict.sev && (
          <span className="font-mono text-[9px] tracking-wide uppercase" style={{ color: 'var(--green)' }}>
            {verdict.label}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="font-display text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {w.coverage_pct != null ? `${w.coverage_pct}%` : '—'}
        </span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          {w.mapped.toLocaleString()} / {w.total.toLocaleString()}
        </span>
      </div>
      <div
        className="rounded-full overflow-hidden mb-1"
        style={{ height: 6, background: 'var(--border-base)' }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: bar,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      <div className="flex items-center justify-between font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
        <span>{w.unmapped.toLocaleString()} unmapped</span>
        <span>target ≥ 80%</span>
      </div>
    </Card>
  );
}

// ─── Daily 30d trend chart ───────────────────────────────────────
function DailyTrend({ data }: { data: GeoCoveragePayload }) {
  const chartData = data.daily_30d
    .filter(d => d.coverage_pct != null)
    .map(d => ({
      day: d.day.slice(5),                 // MM-DD
      coverage: d.coverage_pct as number,
      mapped: d.mapped,
      total:  d.total,
    }));

  if (chartData.length === 0) {
    return (
      <Card variant="elevated" className="p-4">
        <SectionHeader title="Coverage trend · last 30d" />
        <p className="font-mono text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
          No daily coverage samples yet.
        </p>
      </Card>
    );
  }

  return (
    <Card variant="elevated" className="p-4">
      <SectionHeader title="Coverage trend · last 30d" subtitle="80% reference line = target coverage" />
      <div className="mt-2">
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="geo-coverage-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stopColor="var(--green)" stopOpacity={0.40} />
                <stop offset="100%" stopColor="var(--green)" stopOpacity={0} />
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
              domain={[0, 100]}
              tick={{ fontSize: 9, fill: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}%`}
              width={32}
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
              formatter={(v) => {
                const num = typeof v === 'number' ? v : Number(v);
                return [`${num.toFixed(1)}%`, 'Coverage'];
              }}
            />
            <ReferenceLine
              y={80}
              stroke="var(--text-tertiary)"
              strokeDasharray="3 3"
              strokeWidth={1}
              label={{ value: 'Target 80%', position: 'insideTopRight', fill: 'var(--text-tertiary)', fontSize: 9, fontFamily: 'var(--font-mono)' }}
            />
            <Area
              type="monotone"
              dataKey="coverage"
              stroke="var(--green)"
              strokeWidth={1.5}
              fill="url(#geo-coverage-grad)"
              name="Coverage"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ─── Exhausted pile grid ─────────────────────────────────────────
function ExhaustedGrid({ data }: { data: GeoCoveragePayload }) {
  const items = data.exhausted.by_feed;
  const total = data.exhausted.total;
  const [selected, setSelected] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <div className="space-y-2">
        <SectionHeader title="Exhausted pile · cartographer skipped" />
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No threats in the exhausted pile — cartographer is keeping up.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeader
        title={`Exhausted pile · ${total.toLocaleString()} threats cartographer skipped`}
        count={items.length}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((row, i) => {
          const key = `${row.source_feed}::${row.threat_type}`;
          const pct = total > 0 ? (row.n / total) * 100 : 0;
          const isSel = selected === key;
          return (
            <Fragment key={key}>
              <ExhaustedCard
                rank={i + 1}
                row={row}
                pctOfTotal={pct}
                isSelected={isSel}
                onSelect={() => setSelected(prev => prev === key ? null : key)}
              />
              {isSel && <ExhaustedDetail row={row} pctOfTotal={pct} />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function exhaustedTier(pct: number): Tone {
  if (pct >= 30) return 'critical';
  if (pct >= 15) return 'high';
  return 'green';
}

function ExhaustedCard({
  rank, row, pctOfTotal, isSelected, onSelect,
}: {
  rank:       number;
  row:        GeoCoverageExhaustedByFeed;
  pctOfTotal: number;
  isSelected: boolean;
  onSelect:   () => void;
}) {
  const tier = exhaustedTier(pctOfTotal);
  const variant: 'elevated' | 'critical' = tier === 'critical' ? 'critical' : 'elevated';
  const barColor = toneColor(tier);

  return (
    <Card
      variant={variant}
      className="p-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="font-mono text-[10px] font-bold w-5 h-5 rounded grid place-items-center flex-shrink-0"
          style={{ background: 'var(--bg-input)', color: 'var(--text-tertiary)' }}
        >
          {rank}
        </span>
        <span className="font-display text-base font-bold flex-1" style={{ color: 'var(--text-primary)' }}>
          {row.n.toLocaleString()}
        </span>
        <span className="font-mono text-[10px] font-bold flex-shrink-0" style={{ color: barColor }}>
          {pctOfTotal.toFixed(0)}%
        </span>
        <ChevronDown
          size={12}
          style={{
            color:      'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </div>
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
      <div className="font-mono text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
        {row.source_feed}
      </div>
      <div className="font-mono text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
        type: {row.threat_type}
      </div>
    </Card>
  );
}

function ExhaustedDetail({ row, pctOfTotal }: { row: GeoCoverageExhaustedByFeed; pctOfTotal: number }) {
  return (
    <Card variant="elevated" className="p-4 col-span-full">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <Stat label="Skipped count"   value={row.n.toLocaleString()} />
        <Stat label="% of total pile" value={`${pctOfTotal.toFixed(1)}%`} />
        <Stat label="Source feed"     value={row.source_feed} mono />
      </div>
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
        Threat type
      </div>
      <div className="font-mono text-[12px] mb-4" style={{ color: 'var(--text-primary)' }}>
        {row.threat_type}
      </div>
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
        Why these are exhausted
      </div>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Cartographer hit its retry budget on these threats and stopped attempting geo enrichment.
        Likely causes: domain doesn't resolve, IP geo provider returned NO_MATCH for the resolved
        IP, or the threat record arrived without a usable indicator. Investigate by sampling
        a few rows from <code style={{ color: 'var(--text-primary)' }}>threats</code> where{' '}
        <code style={{ color: 'var(--text-primary)' }}>source_feed='{row.source_feed}'</code> AND{' '}
        <code style={{ color: 'var(--text-primary)' }}>threat_type='{row.threat_type}'</code> AND{' '}
        <code style={{ color: 'var(--text-primary)' }}>cartographer_status='exhausted'</code>.
      </p>
    </Card>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────
function SectionHeader({ title, subtitle, count }: { title: string; subtitle?: string; count?: number }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </div>
        {subtitle && (
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            {subtitle}
          </div>
        )}
      </div>
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

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className={mono ? 'text-sm font-mono' : 'text-base font-mono'} style={{ color: 'var(--text-primary)' }}>
        {value}
      </div>
    </div>
  );
}
