// Stacked-area inflow chart for the Threats page.
//
// Reads /api/threats/inflow which serves the threat_cube_status cube
// (migration 0124). Hourly buckets, stacked by threat_type. 24h or 7d
// window via a small toggle.
//
// Pure SVG paths — no chart library — so the bundle stays tight and
// the component is easy to skin against brand tokens. Responsive
// design via viewBox: the SVG scales to the container width on
// desktop and shrinks gracefully on mobile, where we also swap the
// hover tooltip for a tap-to-show pattern.
//
// Visual goals:
//   - Glass-card backdrop sits inside the page's design system
//   - Layers ordered largest → smallest so the dominant type
//     anchors the baseline
//   - Pulse on the leading edge so the chart feels live
//   - Smooth Catmull-Rom-ish curves so the stacked layers don't
//     look like a Lego staircase

import { useMemo, useRef, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';

// Brand-aligned threat-type palette. Anything not in the map falls
// back to a deterministic hash-based color so new types don't render
// invisible.
const TYPE_COLORS: Record<string, string> = {
  phishing:               '#C83C3C', // var(--red) — the headline attack
  malware_distribution:   '#fb923c',
  credential_harvesting:  '#fbbf24',
  typosquatting:          '#E5A832', // var(--amber)
  malicious_ip:           '#0A8AB5', // var(--blue)
  c2:                     '#8b5cf6',
  spam:                   '#6b7280',
  social_engineering:     '#ec4899',
  defacement:             '#10b981',
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
  return type
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

// Catmull-Rom → cubic Bezier for smooth area paths. This is the
// minimal version that handles open paths and clamps tension to
// avoid overshoot when adjacent buckets differ by a large amount.
function buildSmoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0]![0]} ${points[0]![1]}`;
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? points[i + 1]!;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

interface ChartGeometry {
  width: number;
  height: number;
  padX: number;
  padTop: number;
  padBottom: number;
  innerW: number;
  innerH: number;
}

interface BuiltSeries {
  threat_type: string;
  total: number;
  color: string;
  /** Stacked top edge as [x, y] points in SVG units. */
  topPoints: Array<[number, number]>;
  /** Stacked bottom edge as [x, y] points (the previous layer's top). */
  bottomPoints: Array<[number, number]>;
  /** Last-bucket count for the current value display. */
  current: number;
}

function buildSeries(data: InflowResponse, geom: ChartGeometry): BuiltSeries[] {
  const { innerW, innerH, padX, padTop } = geom;
  const n = data.buckets.length;
  const xStep = n > 1 ? innerW / (n - 1) : innerW;
  // Per-bucket totals → max → y scale
  const totalsPerBucket = new Array<number>(n).fill(0);
  for (const s of data.series) {
    for (let i = 0; i < n; i++) totalsPerBucket[i] = (totalsPerBucket[i] ?? 0) + (s.counts[i] ?? 0);
  }
  const maxTotal = Math.max(1, ...totalsPerBucket);
  const yFor = (cumulative: number) => padTop + innerH - (cumulative / maxTotal) * innerH;

  // Stack from baseline up. The api returns series sorted by `total`
  // descending — keep that order so the dominant type sits flat on
  // the baseline.
  const cumulative = new Array<number>(n).fill(0);
  const built: BuiltSeries[] = [];
  for (const s of data.series) {
    const bottomPoints: Array<[number, number]> = [];
    const topPoints: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const x = padX + i * xStep;
      const yBottom = yFor(cumulative[i] ?? 0);
      bottomPoints.push([x, yBottom]);
      cumulative[i] = (cumulative[i] ?? 0) + (s.counts[i] ?? 0);
      const yTop = yFor(cumulative[i] ?? 0);
      topPoints.push([x, yTop]);
    }
    built.push({
      threat_type: s.threat_type,
      total: s.total,
      color: colorFor(s.threat_type),
      topPoints,
      bottomPoints,
      current: s.counts[s.counts.length - 1] ?? 0,
    });
  }
  return built;
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
}

export function ThreatInflowChart({ height }: Props = {}) {
  const [window, setWindow] = useState<Window>('24h');
  const { data, isLoading } = useThreatInflow(window);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(800);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Observe the container for responsive width. SVG scales via
  // viewBox but we need the actual pixel width to compute the
  // hover-bucket from a clientX coordinate.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setContainerW(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isMobile = containerW < 640;
  const chartHeight = height ?? (isMobile ? 160 : 220);

  const geom: ChartGeometry = useMemo(() => {
    const padX = 8;
    const padTop = 12;
    const padBottom = 22;
    return {
      width: containerW,
      height: chartHeight,
      padX,
      padTop,
      padBottom,
      innerW: Math.max(1, containerW - padX * 2),
      innerH: Math.max(1, chartHeight - padTop - padBottom),
    };
  }, [containerW, chartHeight]);

  const built = useMemo(
    () => (data ? buildSeries(data, geom) : []),
    [data, geom],
  );

  // Vertical guideline + tooltip math
  const hoverBucket = data && hoverIdx !== null ? data.buckets[hoverIdx] : null;
  const hoverX = hoverIdx !== null && data
    ? geom.padX + (hoverIdx * geom.innerW) / Math.max(1, data.buckets.length - 1)
    : null;

  // Axis tick positions for the bottom axis
  const ticks = useMemo(() => {
    if (!data) return [];
    const desired = isMobile ? 4 : (window === '7d' ? 7 : 6);
    const n = data.buckets.length;
    const step = Math.max(1, Math.floor(n / (desired - 1)));
    const out: Array<{ x: number; label: string }> = [];
    for (let i = 0; i < n; i += step) {
      out.push({
        x: geom.padX + (i * geom.innerW) / Math.max(1, n - 1),
        label: formatAxisTick(data.buckets[i]!, window),
      });
    }
    // Always include the last bucket so the right edge is anchored.
    if (out[out.length - 1]?.x !== geom.padX + geom.innerW) {
      out.push({
        x: geom.padX + geom.innerW,
        label: formatAxisTick(data.buckets[n - 1]!, window),
      });
    }
    return out;
  }, [data, geom, window, isMobile]);

  const handlePointer = (clientX: number) => {
    if (!data || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const localX = clientX - rect.left;
    const n = data.buckets.length;
    const ratio = (localX - geom.padX) / geom.innerW;
    const idx = Math.round(ratio * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  // Headline figure for the card (window-scoped total)
  const headline = data?.total ?? 0;

  return (
    <Card style={{ padding: isMobile ? 12 : 18 }}>
      {/* Header row: title, headline number, window toggle */}
      <div style={{
        display: 'flex', alignItems: isMobile ? 'flex-start' : 'center',
        justifyContent: 'space-between', gap: 12,
        flexDirection: isMobile ? 'column' : 'row',
        marginBottom: 10,
      }}>
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
            fontSize: isMobile ? 22 : 26, fontWeight: 700,
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
        <WindowToggle value={window} onChange={(v) => { setWindow(v); setHoverIdx(null); }} />
      </div>

      {/* Chart */}
      <div
        ref={containerRef}
        onMouseMove={(e) => handlePointer(e.clientX)}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={(e) => { const t = e.touches[0]; if (t) handlePointer(t.clientX); }}
        onTouchMove={(e) => { const t = e.touches[0]; if (t) handlePointer(t.clientX); }}
        style={{
          position: 'relative',
          width: '100%',
          height: chartHeight,
          touchAction: 'pan-y',
        }}
      >
        {isLoading || !data ? (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 11,
          }}>
            {isLoading ? 'Loading inflow…' : 'No data'}
          </div>
        ) : (
          <svg
            width={containerW}
            height={chartHeight}
            viewBox={`0 0 ${containerW} ${chartHeight}`}
            preserveAspectRatio="none"
            style={{ display: 'block' }}
          >
            <defs>
              {built.map((s) => (
                <linearGradient
                  key={s.threat_type}
                  id={`tic-${s.threat_type.replace(/[^a-z0-9_-]/gi, '')}`}
                  x1="0" y1="0" x2="0" y2="1"
                >
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.85} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.55} />
                </linearGradient>
              ))}
            </defs>

            {/* Area layers — drawn smallest-on-top so the dominant
                type's bottom edge sits flat. We iterate the API order
                (already largest-first) and let the SVG painter's
                algorithm stack them. */}
            {built.map((s) => {
              const id = `tic-${s.threat_type.replace(/[^a-z0-9_-]/gi, '')}`;
              const top = buildSmoothPath(s.topPoints);
              const bottom = [...s.bottomPoints].reverse();
              const bottomCmds = bottom.map((p, i) => (i === 0 ? `L ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ');
              return (
                <g key={s.threat_type}>
                  <path
                    d={`${top} ${bottomCmds} Z`}
                    fill={`url(#${id})`}
                    stroke="none"
                  />
                </g>
              );
            })}

            {/* Bottom axis line */}
            <line
              x1={geom.padX}
              x2={geom.padX + geom.innerW}
              y1={geom.padTop + geom.innerH}
              y2={geom.padTop + geom.innerH}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={1}
            />

            {/* X-axis tick labels */}
            {ticks.map((t, i) => (
              <text
                key={i}
                x={t.x}
                y={chartHeight - 6}
                fontFamily="var(--font-mono)"
                fontSize={isMobile ? 9 : 10}
                fill="rgba(255,255,255,0.4)"
                textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
              >
                {t.label}
              </text>
            ))}

            {/* Hover guideline */}
            {hoverX !== null && (
              <line
                x1={hoverX}
                x2={hoverX}
                y1={geom.padTop}
                y2={geom.padTop + geom.innerH}
                stroke="rgba(255,255,255,0.45)"
                strokeWidth={1}
                strokeDasharray="2 3"
                pointerEvents="none"
              />
            )}

            {/* Leading edge pulse — sits on top of the topmost stack
                point at the rightmost bucket. */}
            {built.length > 0 && (() => {
              const last = built[built.length - 1]!.topPoints;
              const p = last[last.length - 1]!;
              return (
                <g pointerEvents="none">
                  <circle cx={p[0]} cy={p[1]} r={6} fill="var(--amber)" opacity={0.25}>
                    <animate attributeName="r" values="6;14;6" dur="2.4s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.45;0;0.45" dur="2.4s" repeatCount="indefinite" />
                  </circle>
                  <circle cx={p[0]} cy={p[1]} r={3.5} fill="var(--amber)" />
                </g>
              );
            })()}
          </svg>
        )}

        {/* Tooltip */}
        {hoverBucket && data && hoverX !== null && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: Math.min(Math.max(0, hoverX - 100), containerW - 200),
              width: 200,
              background: 'rgba(20,26,38,0.96)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 8,
              padding: '8px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-primary)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
              pointerEvents: 'none',
              backdropFilter: 'blur(10px)',
            }}
          >
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 4 }}>
              {formatBucketLabel(hoverBucket, window)}
            </div>
            {built.map((s) => {
              const series = data.series.find((x) => x.threat_type === s.threat_type);
              const value = series?.counts[hoverIdx ?? 0] ?? 0;
              if (value === 0) return null;
              return (
                <div key={s.threat_type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {prettyTypeLabel(s.threat_type)}
                  </span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                    {value.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Legend — compact on mobile (horizontal scroll), grid on desktop */}
      <div
        style={{
          marginTop: 10,
          display: isMobile ? 'flex' : 'grid',
          gridTemplateColumns: isMobile ? undefined : 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 6,
          overflowX: isMobile ? 'auto' : 'visible',
          paddingBottom: isMobile ? 4 : 0,
        }}
      >
        {built.map((s) => (
          <div
            key={s.threat_type}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontFamily: 'var(--font-mono)', fontSize: 10,
              color: 'var(--text-secondary)',
              flexShrink: 0,
              padding: isMobile ? '4px 6px' : 0,
              border: isMobile ? '1px solid rgba(255,255,255,0.08)' : 'none',
              borderRadius: isMobile ? 6 : 0,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              {prettyTypeLabel(s.threat_type)}
            </span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
              {s.total.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </Card>
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
        display: 'flex',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: 2,
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
