// Stacked-area inflow chart for /threats and Home (Threat Pulse).
//
// Reads /api/threats/inflow which serves the threat_cube_status cube
// (migration 0124). Hourly buckets, stacked by threat_type. 24h or 7d
// window via a small toggle.
//
// Renders with Recharts' AreaChart so the curves match the Threat
// Volume chart on /trends visually — same smoothing (`type="monotone"`),
// same translucent fill (`fillOpacity={0.3}`). Header, headline number,
// window toggle, custom tooltip, and totals legend are kept above and
// below the chart so the surface still tells the same story.

import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useTokenColors, type Rgba } from '@averrow/shared/theme';
import { useThreatInflow } from './useThreatInflow';
import type { InflowWindow } from './useThreatInflow';
import { Card, PageState } from '@/design-system/components';
import { THREATS_CARD_VARIANT } from './threatsCard';
import './threats.css';

// Threat-type -> categorical chart token (--chart-1..6, fixed per type so a filter
// or a re-sort never repaints a series). Types beyond the six categorical slots fold
// into one neutral "other" token instead of generating more hues. Recharts needs
// resolved colours, so the tokens are read at runtime (useTokenColors) and the chart
// follows theme / accent changes.
const TYPE_TOKENS: Record<string, string> = {
  phishing:              '--chart-1',
  malware_distribution:  '--chart-2',
  malicious_ip:          '--chart-3',
  c2:                    '--chart-4',
  typosquatting:         '--chart-5',
  credential_harvesting: '--chart-6',
};
const OTHER_TOKEN = '--text-muted';
const CHROME_TOKENS = ['--text-tertiary', '--text-secondary', '--border-base', '--border-strong'] as const;
const TOKEN_NAMES = [...new Set([...Object.values(TYPE_TOKENS), OTHER_TOKEN, ...CHROME_TOKENS])];

function tokenFor(type: string): string {
  return TYPE_TOKENS[type] ?? OTHER_TOKEN;
}

/** Resolved token -> an rgba() string Recharts can paint; before it resolves (SSR / jsdom) fall back to the CSS variable. */
function paint(colors: Record<string, Rgba | null>, token: string): string {
  const c = colors[token];
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${+(c[3] / 255).toFixed(3)})` : `var(${token})`;
}

function prettyTypeLabel(type: string): string {
  // Acronyms that should stay all-caps after the snake_case → space split.
  // Without this, `malicious_ip` becomes "Malicious Ip" (regex \b\w only
  // touches the first character of each word).
  const ACRONYMS = new Set(['ip', 'c2', 'dns', 'mx', 'spf', 'dkim', 'dmarc', 'bimi', 'vmc', 'asn', 'ssl', 'tls', 'url']);
  return type
    .split('_')
    .map((w) => (ACRONYMS.has(w.toLowerCase())
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

type Window = InflowWindow;

function formatBucketLabel(iso: string, window: Window): string {
  // iso is `YYYY-MM-DD HH:00:00` (UTC). Show local time in the user's
  // browser TZ for the tooltip — operators triage in their local
  // timezone.
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (window === '7d') {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatAxisTick(iso: string, window: Window): string {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (window === '7d') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  /** Override the default desktop height (mobile uses a smaller height). */
  height?: number;
  /** Initial time window. Defaults to "24h" everywhere; users flip to
   *  "7d" via the in-chart segmented toggle. */
  defaultWindow?: Window;
}

export function ThreatInflowChart({ height, defaultWindow = '24h' }: Props = {}) {
  const [window, setWindow] = useState<Window>(defaultWindow);
  const { colors } = useTokenColors(TOKEN_NAMES);
  const tickFill = paint(colors, '--text-tertiary');
  const axisStroke = paint(colors, '--border-base');
  const { data, isLoading, isError, refetch } = useThreatInflow(window);
  const failed = isError && !data;

  // Pivot the API response into Recharts' flat-row shape:
  //   [{ bucket, phishing, malware_distribution, ...other types }, ...]
  // The series array from the API is already sorted by total desc,
  // and `<Area />` elements stack in the order they're rendered, so
  // mapping over data.series preserves the dominant-on-bottom layering.
  const chartData = data
    ? data.buckets.map((bucket, i) => {
        const row: Record<string, string | number> = { bucket };
        for (const s of data.series) row[s.threat_type] = s.counts[i] ?? 0;
        return row;
      })
    : [];

  const chartHeight = height ?? 220;
  const headline = data?.total ?? null;

  return (
    <Card variant={THREATS_CARD_VARIANT} style={{ padding: 18 }}>
      {/* Header row: title, headline number, window toggle */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
        <div>
          <h3 className="thr-label">Threat inflow</h3>
          <div className="thr-num" style={{
            fontFamily: 'var(--font-display)',
            fontSize: 26, fontWeight: 700,
            color: 'var(--text-primary)', lineHeight: 1.1,
          }}>
            {headline === null ? '—' : headline.toLocaleString()}
          </div>
          <div className="thr-label">
            new indicators · {window === '7d' ? 'last 7 days' : 'last 24h'}
          </div>
        </div>
        <WindowToggle value={window} onChange={setWindow} />
      </div>

      {/* Chart */}
      {failed ? (
        <PageState kind="error" layout="card" compact title="Couldn't load threat inflow" onRetry={() => { void refetch(); }} />
      ) : isLoading || !data ? (
        <div
          className="thr-label"
          style={{
            height: chartHeight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isLoading ? 'Loading inflow…' : 'No data'}
        </div>
      ) : (
        <ResponsiveContainer
          width="100%"
          height={chartHeight}
        >
          <AreaChart data={chartData} margin={{ top: 14, right: 8, bottom: 16, left: 0 }}>
            <XAxis
              dataKey="bucket"
              tick={{ fill: tickFill, fontSize: 12, fontFamily: 'var(--font-mono)' }}
              axisLine={{ stroke: axisStroke }}
              tickLine={false}
              tickFormatter={(v: string) => formatAxisTick(v, window)}
              interval="preserveStartEnd"
              minTickGap={32}
            />
            <YAxis
              tick={{ fill: tickFill, fontSize: 12, fontFamily: 'var(--font-mono)' }}
              axisLine={false}
              tickLine={false}
              width={48}
              // Monotone smoothing curves slightly above the highest data
              // point; without the 8% domain padding the smoothed peaks
              // clip against the top of the plot area.
              domain={[0, (dataMax: number) => Math.ceil(dataMax * 1.08)]}
              tickFormatter={(v: number) => {
                if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
                if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
                return String(v);
              }}
            />
            <Tooltip
              content={<InflowTooltip window={window} />}
              cursor={{ stroke: tickFill, strokeDasharray: '2 3' }}
            />
            {data.series.map((s) => {
              const c = paint(colors, tokenFor(s.threat_type));
              return (
                <Area
                  key={s.threat_type}
                  type="monotone"
                  dataKey={s.threat_type}
                  stackId="1"
                  stroke={c}
                  fill={c}
                  fillOpacity={0.3}
                  name={prettyTypeLabel(s.threat_type)}
                  isAnimationActive={false}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      )}

      {/* Legend — totals per series. Two columns on narrow vertical
          mobile (six series fit as a 3×2 grid, half the height of a
          single column so the chart's X-axis labels can't crash into
          the first row), auto-fill grid on wider widths. */}
      {data && (
        <div
          className="grid grid-cols-2 md:grid-cols-[repeat(auto-fill,minmax(160px,1fr))]"
          style={{ marginTop: 16, gap: 6 }}
        >
          {data.series.map((s) => (
            <div
              key={s.threat_type}
              className="thr-legend-item max-md:px-1.5 max-md:py-1 max-md:border max-md:border-[var(--border-base)] max-md:rounded-md"
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: paint(colors, tokenFor(s.threat_type)),
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={prettyTypeLabel(s.threat_type)}
              >
                {prettyTypeLabel(s.threat_type)}
              </span>
              <span className="thr-num" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                {s.total.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface InflowTooltipPayloadEntry {
  name?: string;
  dataKey?: string | number;
  value?: number;
  color?: string;
}

interface InflowTooltipProps {
  active?: boolean;
  payload?: InflowTooltipPayloadEntry[];
  label?: string | number;
  window: Window;
}

function InflowTooltip({
  active,
  payload,
  label,
  window,
}: InflowTooltipProps) {
  if (!active || !payload?.length || typeof label !== 'string') return null;
  // Filter out zero-value entries so the tooltip stays compact during
  // quiet hours; Recharts always sends every series.
  const nonZero = (payload as InflowTooltipPayloadEntry[])
    .filter((p) => (p.value ?? 0) > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  if (nonZero.length === 0) return null;

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-strong)',
        borderRadius: 8,
        padding: '8px 10px',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--type-label-size, 12px)',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--text-primary)',
        minWidth: 200,
      }}
    >
      <div style={{ color: 'var(--text-tertiary)', marginBottom: 4 }}>
        {formatBucketLabel(label, window)}
      </div>
      {nonZero.map((p) => (
        <div
          key={String(p.dataKey)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}
        >
          <span
            style={{
              width: 8, height: 8, borderRadius: 2,
              background: p.color, flexShrink: 0,
            }}
          />
          <span style={{
            flex: 1, color: 'var(--text-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {p.name}
          </span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
            {(p.value ?? 0).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function WindowToggle({ value, onChange }: { value: Window; onChange: (v: Window) => void }) {
  const opts: Array<{ v: Window; label: string }> = [
    { v: '24h', label: '24h' },
    { v: '7d',  label: '7d'  },
  ];
  return (
    <div role="tablist" aria-label="Time window" className="thr-seg">
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="tab"
          aria-selected={o.v === value}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
