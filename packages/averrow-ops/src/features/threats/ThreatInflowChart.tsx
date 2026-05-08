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
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  type TooltipProps,
} from 'recharts';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';

// Threat-type → fill/stroke color. Aligned with the Threat Volume
// chart on /trends so the palette stays consistent across the two
// surfaces that visualize the same data shape.
const TYPE_COLORS: Record<string, string> = {
  phishing:               '#C83C3C', // red — the headline attack
  malware_distribution:   '#9333ea', // purple — distinct from phishing
  malicious_ip:           '#78A0C8', // slate blue
  c2:                     '#ef4444', // lighter red
  typosquatting:          '#DCAA32', // gold
  credential_harvesting:  '#E8923C', // orange
  spam:                   '#6b7280', // gray
  social_engineering:     '#ec4899', // pink
  defacement:             '#10b981', // emerald
};

const FALLBACK_COLORS = ['#4ade80', '#06b6d4', '#a78bfa', '#f472b6', '#facc15'];

function colorFor(type: string): string {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type]!;
  // Hash for deterministic fallback — same color across page reloads.
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length]!;
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

interface InflowResponse {
  window: '24h' | '7d';
  buckets: string[];
  series: Array<{ threat_type: string; counts: number[]; total: number }>;
  total: number;
  generated_at: string;
}

type Window = '24h' | '7d';

function useThreatInflow(window: Window) {
  return useQuery({
    queryKey: ['threats', 'inflow', window],
    queryFn: async (): Promise<InflowResponse | null> => {
      try {
        const res = await api.get(`/api/threats/inflow?window=${window}`);
        return res as unknown as InflowResponse;
      } catch {
        return null;
      }
    },
    refetchInterval: 5 * 60_000, // matches cube refresh cadence
    staleTime: 60_000,
  });
}

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
  const { data, isLoading } = useThreatInflow(window);

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
  const headline = data?.total ?? 0;

  return (
    <Card style={{ padding: 18 }}>
      {/* Header row: title, headline number, window toggle */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
        <div>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            color: 'var(--text-tertiary)', letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}>
            Threat Inflow
          </div>
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: 26, fontWeight: 700,
            color: 'var(--text-primary)', lineHeight: 1.1,
          }}>
            {headline.toLocaleString()}
          </div>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            color: 'var(--text-tertiary)', letterSpacing: '0.06em',
          }}>
            new indicators · {window === '7d' ? 'last 7 days' : 'last 24h'}
          </div>
        </div>
        <WindowToggle value={window} onChange={setWindow} />
      </div>

      {/* Chart */}
      {isLoading || !data ? (
        <div
          style={{
            height: chartHeight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
          }}
        >
          {isLoading ? 'Loading inflow…' : 'No data'}
        </div>
      ) : (
        <ResponsiveContainer
          width="100%"
          height={chartHeight}
        >
          <AreaChart data={chartData} margin={{ top: 10, right: 8, bottom: 16, left: -16 }}>
            <XAxis
              dataKey="bucket"
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              tickLine={false}
              tickFormatter={(v: string) => formatAxisTick(v, window)}
              interval="preserveStartEnd"
              minTickGap={32}
            />
            <YAxis
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
              axisLine={false}
              tickLine={false}
              width={44}
              tickFormatter={(v: number) => {
                if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
                if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
                return String(v);
              }}
            />
            <Tooltip
              content={<InflowTooltip window={window} />}
              cursor={{ stroke: 'rgba(255,255,255,0.45)', strokeDasharray: '2 3' }}
            />
            {data.series.map((s) => {
              const c = colorFor(s.threat_type);
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
              className="flex items-center gap-1.5 max-md:px-1.5 max-md:py-1 max-md:border max-md:border-white/10 max-md:rounded-md"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: colorFor(s.threat_type),
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
              <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
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

function InflowTooltip({
  active,
  payload,
  label,
  window,
}: TooltipProps<number, string> & { window: Window }) {
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
        background: 'rgba(20,26,38,0.96)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 8,
        padding: '8px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-primary)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        minWidth: 200,
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 4 }}>
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
    { v: '24h', label: '24H' },
    { v: '7d',  label: '7D'  },
  ];
  return (
    <div
      role="tablist"
      aria-label="Time window"
      style={{
        display: 'inline-flex',
        // alignSelf prevents the parent flex-col from stretching this
        // pill across the full width of the card on narrow mobile.
        alignSelf: 'flex-start',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: 2,
        flexShrink: 0,
      }}
    >
      {opts.map((o) => {
        const active = o.v === value;
        return (
          <button
            key={o.v}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.v)}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
              letterSpacing: '0.08em',
              padding: '6px 12px',
              border: 'none',
              cursor: 'pointer',
              borderRadius: 6,
              color: active ? 'var(--bg-page)' : 'var(--text-secondary)',
              background: active ? 'var(--amber)' : 'transparent',
              transition: 'background 0.15s ease, color 0.15s ease',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
