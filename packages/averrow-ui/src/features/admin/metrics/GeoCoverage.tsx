// Geo Coverage — Metrics page section 4.
//
// Three-window coverage % (24h / 7d / 30d) with verdict pills,
// a 30-day daily trend chart, and the cartographer-exhausted
// pile summary. Coverage = (threats with lat/lng) / (total
// threats), measured against threat_cube_geo and
// threat_cube_status — the same numbers diagnostics surfaces.

import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { useGeoCoverage, type GeoCoveragePayload, type GeoCoverageWindow } from '@/hooks/useMetrics';
import { MetricsTile } from './MetricsTile';

export function GeoCoverageSection() {
  const { data, isLoading, isError } = useGeoCoverage();

  return (
    <Card style={{ padding: '16px' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="section-label font-mono font-bold">Geo Coverage</span>
        {data && (
          <span
            className="font-mono text-[9px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            mapped / total
          </span>
        )}
      </div>

      {isError ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load geo coverage. Try again in a moment.
        </p>
      ) : isLoading || !data ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading coverage…
        </p>
      ) : (
        <div className="space-y-4">
          <CoverageWindows windows={data.windows} />
          <DailyTrend data={data} />
          <ExhaustedPile data={data} />
        </div>
      )}
    </Card>
  );
}

function CoverageWindows({ windows }: { windows: GeoCoverageWindow[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {windows.map((w) => {
        const pct = w.coverage_pct;
        const verdict =
          pct == null   ? { tone: 'inactive' as const, label: 'NO DATA'   }
            : pct >= 80 ? { tone: 'success'  as const, label: 'HEALTHY'   }
              : pct >= 50 ? { tone: 'warning'  as const, label: 'DEGRADED'  }
                : { tone: 'failed'  as const, label: 'IMPAIRED' };
        return (
          <MetricsTile
            key={w.window}
            label={w.window}
            tone={verdict.tone}
            badge={<Badge status={verdict.tone} label={verdict.label} size="xs" />}
          >
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {pct != null ? `${pct}%` : '—'}
              </span>
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {w.mapped.toLocaleString()} / {w.total.toLocaleString()}
              </span>
            </div>
            <div
              className="rounded-full overflow-hidden"
              style={{ height: 4, background: 'rgba(255,255,255,0.06)' }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, pct ?? 0))}%`,
                  background:
                    verdict.tone === 'success' ? 'var(--sev-info)'
                      : verdict.tone === 'warning' ? 'var(--sev-medium)'
                        : verdict.tone === 'failed'  ? 'var(--sev-critical)'
                          : 'var(--text-muted)',
                  transition: 'width 0.4s ease',
                }}
              />
            </div>
          </MetricsTile>
        );
      })}
    </div>
  );
}

function DailyTrend({ data }: { data: GeoCoveragePayload }) {
  const series = data.daily_30d.map((d) => ({
    day: d.day.slice(5), // 'MM-DD'
    pct: d.coverage_pct ?? 0,
    mapped: d.mapped,
    total: d.total,
  }));
  if (series.length === 0) {
    return (
      <div>
        <Header label="Daily coverage % (30d)" />
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No data in the last 30 days.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Header label="Daily coverage % (30d)" />
      <div style={{ height: 110 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="geoCovFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="var(--sev-info)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="var(--sev-info)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="day"
              tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.30)' }}
              interval="preserveStartEnd"
              axisLine={false}
              tickLine={false}
            />
            <YAxis hide domain={[0, 100]} />
            {/* Visual targets — 80% healthy line, 50% warn line. */}
            <ReferenceLine y={80} stroke="rgba(76,175,80,0.30)" strokeDasharray="3 3" />
            <ReferenceLine y={50} stroke="rgba(229,168,50,0.30)" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-base)',
                borderRadius: 6,
                fontSize: 10,
              }}
              labelStyle={{ color: 'var(--text-secondary)' }}
              formatter={(v, _name, p) => {
                const row = (p as { payload?: typeof series[number] }).payload;
                if (!row) return [`${v}%`, 'coverage'];
                return [`${v}% (${row.mapped.toLocaleString()} / ${row.total.toLocaleString()})`, 'coverage'];
              }}
            />
            <Area
              type="monotone"
              dataKey="pct"
              stroke="var(--sev-info)"
              strokeWidth={1.5}
              fill="url(#geoCovFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div
        className="font-mono text-[8px] mt-1"
        style={{ color: 'var(--text-muted)' }}
      >
        Dashed lines: 80% healthy · 50% degraded
      </div>
    </div>
  );
}

function ExhaustedPile({ data }: { data: GeoCoveragePayload }) {
  const { exhausted } = data;
  return (
    <div>
      <Header label="Cartographer exhausted (5+ enrichment attempts, no geo)" />
      <div className="flex items-baseline gap-2 mb-2">
        <span className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          {exhausted.total.toLocaleString()}
        </span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          stuck threats
        </span>
      </div>
      {exhausted.by_feed.length === 0 ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No exhausted threats.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {exhausted.by_feed.map((row) => (
            <li
              key={`${row.source_feed}/${row.threat_type}`}
              className="flex items-baseline gap-3 py-1 border-b border-white/[0.04]"
            >
              <span
                className="font-mono text-[10px] font-bold w-12 text-right shrink-0"
                style={{ color: 'var(--text-primary)' }}
              >
                {row.n.toLocaleString()}
              </span>
              <span
                className="font-mono text-[10px] flex-1 truncate"
                style={{ color: 'var(--text-secondary)' }}
              >
                {row.source_feed}
                <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  {' / '}{row.threat_type}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
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
