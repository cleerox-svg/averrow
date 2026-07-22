// Pipelines — v3 treatment, now the "Pipelines" tab of /admin (Tier 3
// merged the standalone /admin/metrics page into /admin as tabs; this
// component itself wasn't rebuilt, only re-homed).
//
// Refinement of the v2 PipelineAutomationSection — keeps the
// verdict-tinted card grid (operators already read it well) and
// adds the click-to-inline-expand pattern that agents-v3 / feeds-v3
// use, plus an explicit failure-pattern reason line under the
// verdict pill so "STALE" / "GROWING" stops requiring inference.
//
// What changed vs v2:
//   1. Click opens inline below the card (was a centered modal)
//   2. Reason text under verdict pill — explicit numeric / time
//      detail (e.g. "+3,500 since last cycle", "no measurement
//      in 6h")
//   3. Detail panel shows full-width sparkline + 24h failure-rate
//      breakdown + last-run summary + endpoints chip row
//
// Out of scope (queued):
//   - Mini sparkline per card (would need either a fan-out of
//     usePipelineDetail calls or a backend extension to include
//     `sparkline` in /api/admin/pipeline-status — see PR #1178
//     for the same pattern on feeds)

import { Fragment, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import type { VerdictTag } from '@/components/ui/Badge';
import { ChevronDown } from 'lucide-react';
import { usePipelineStatus, usePipelineDetail } from '@/hooks/useAgents';
import type { Agent, PipelineEntry, PipelineDetail } from '@/hooks/useAgents';
import { relativeTime, formatDuration } from '@/lib/time';

// Maps PipelineVerdict.label → VerdictTag for the styled Badge.
// Verdict labels not in this map (EMPTY, SETUP) fall back to
// Badge's `status` prop with the raw label text.
const VERDICT_TAG_BY_LABEL: Record<string, VerdictTag> = {
  CLEAR:    'clear',
  DRAINING: 'draining',
  STEADY:   'steady',
  GROWING:  'growing',
  STALE:    'stale',
  UPDATED:  'updated',
  STABLE:   'stable',
};

function labelToVerdict(label?: string): VerdictTag | undefined {
  if (!label) return undefined;
  return VERDICT_TAG_BY_LABEL[label.toUpperCase()];
}

function trendArrow(dir: string): string {
  if (dir === 'up') return '▲';
  if (dir === 'down') return '▼';
  if (dir === 'flat') return '–';
  return '';
}

function trendBorderColor(dir: string): string {
  if (dir === 'up')   return 'var(--sev-high-border)';
  if (dir === 'down') return 'var(--green-border)';
  return 'var(--border-base)';
}
function trendTopColor(dir: string): string {
  if (dir === 'up')   return 'var(--sev-high)';
  if (dir === 'down') return 'var(--green)';
  return 'var(--border-base)';
}

function agentStatusLabel(status: string): 'active' | 'failed' | 'degraded' | 'inactive' {
  if (status === 'active')   return 'active';
  if (status === 'error')    return 'failed';
  if (status === 'degraded') return 'degraded';
  return 'inactive';
}

// Hand-rolled SVG mini sparkline for pipeline cards. Same pattern
// as the agents-v3 CardHealthChart — single series, gradient fill,
// no axes / tooltip / legend (those live in the expanded detail).
// Color flips to sev-high when the pipeline's verdict is GROWING
// so a problem reads at a glance.
function CardSparkline({
  values, color, width = 100, height = 28,
}: {
  values: number[];
  color:  string;
  width?: number;
  height?: number;
}) {
  if (!values || values.length < 2) return null;
  const N = values.length;
  const peak = Math.max(...values, 1);
  // Inset the drawing area by half the stroke width on each side so
  // the leftmost and rightmost stroke pixels render fully inside the
  // SVG viewport (no half-thickness clip at the edges).
  const STROKE = 1.2;
  const PAD = STROKE / 2;
  const innerW = width - PAD * 2;
  const stepX = N > 1 ? innerW / (N - 1) : innerW;
  const points = values.map((v, i) => {
    const x = PAD + i * stepX;
    const y = height - (v / peak) * (height - 2) - 1;
    return { x, y };
  });
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${(width - PAD).toFixed(1)} ${height} L ${PAD.toFixed(1)} ${height} Z`;
  const gradId   = `pipeline-card-spark-${Math.random().toString(36).slice(2, 9)}`;
  return (
    // Default SVG clipping (no overflow-visible) so strokes near the
    // right edge don't bleed into the card border. The card row uses
    // justify-between, so this SVG sits flush against the right
    // padded edge — overflow-visible would push the rightmost stroke
    // pixel past the card's rounded corner.
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%"  stopColor={color} stopOpacity={0.40} />
          <stop offset="95%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} stroke={color} strokeWidth={STROKE} fill="none" strokeLinejoin="round" />
    </svg>
  );
}

// Explicit failure-pattern / health reason text. Returns null when
// the verdict alone is self-explanatory (CLEAR with 0 backlog).
function pipelineReasonFor(p: PipelineEntry): string | null {
  const verdict = p.verdict?.label?.toUpperCase();
  if (verdict === 'GROWING' && p.trend != null && p.trend !== 0) {
    return `+${Math.abs(p.trend).toLocaleString()} since last cycle`;
  }
  if (verdict === 'DRAINING' && p.trend != null && p.trend !== 0) {
    return `−${Math.abs(p.trend).toLocaleString()} since last cycle`;
  }
  if (verdict === 'STALE' && p.last_measured_at) {
    return `No measurement since ${relativeTime(p.last_measured_at)}`;
  }
  if (verdict === 'STEADY') {
    return 'Backlog stable';
  }
  if (verdict === 'CLEAR') {
    return null; // self-explanatory at backlog 0
  }
  if (verdict === 'EMPTY' || verdict === 'STABLE' || verdict === 'UPDATED' || verdict === 'SETUP') {
    return null; // reference-dataset states — verdict label says it
  }
  // Fallback for unmapped verdicts: surface trend if any.
  if (p.trend != null && p.trend !== 0) {
    return `${trendArrow(p.trend_direction)} ${Math.abs(p.trend).toLocaleString()} since last cycle`;
  }
  return null;
}

interface PipelineCardProps {
  pipeline:    PipelineEntry;
  agentStatus: string;
  isSelected:  boolean;
  onSelect:    () => void;
}

function PipelineCardV3({ pipeline: p, agentStatus, isSelected, onSelect }: PipelineCardProps) {
  const borderColor = p.count === 0
    ? 'var(--border-base)'
    : trendBorderColor(p.trend_direction);
  const topBorderColor = p.count === 0
    ? 'var(--border-base)'
    : trendTopColor(p.trend_direction);
  const reason = pipelineReasonFor(p);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className="rounded-lg overflow-hidden cursor-pointer transition-transform hover:scale-[1.01]"
      style={{
        background: 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${borderColor}`,
        borderTop: `3px solid ${topBorderColor}`,
        boxShadow: 'inset 0 1px 0 var(--border-base), 0 4px 24px rgba(0,0,0,0.40)',
      }}
      aria-label={`${isSelected ? 'Collapse' : 'Expand'} ${p.label} details`}
    >
      <div className="p-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="font-mono text-[10px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>
            {p.label}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Badge
              status={agentStatusLabel(agentStatus)}
              label={p.agent}
              size="xs"
              pulse={agentStatus === 'active'}
            />
            <ChevronDown
              size={12}
              style={{
                color:      'var(--text-tertiary)',
                transition: 'transform 0.18s ease',
                transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </div>
        </div>

        {p.description && (
          <div
            className="font-mono text-[9px] leading-snug mb-2 line-clamp-2"
            style={{ color: 'var(--text-tertiary)' }}
            title={p.description}
          >
            {p.description}
          </div>
        )}

        <div className="flex items-end justify-between gap-2 mb-1">
          <div className="flex items-baseline gap-2">
            <span
              className="font-display text-lg font-bold"
              style={{ color: 'var(--text-primary)', lineHeight: 1 }}
            >
              {p.count.toLocaleString()}
            </span>
            {p.verdict && (() => {
              const v = labelToVerdict(p.verdict.label);
              return v
                ? <Badge verdict={v} size="xs" />
                : <Badge status={p.verdict.tone} label={p.verdict.label} size="xs" />;
            })()}
          </div>
          {/* 24h backlog mini sparkline — only renders when we have
              ≥2 samples. Color flips to sev-high on growing trend
              so problems read at a glance. */}
          {p.sparkline && p.sparkline.length >= 2 && (
            <CardSparkline
              values={p.sparkline.map(s => s.count)}
              color={p.trend_direction === 'up' ? 'var(--sev-high)' : 'var(--amber)'}
              width={80}
              height={24}
            />
          )}
        </div>

        {/* Explicit reason — what the verdict means in numbers/time */}
        {reason && (
          <div
            className="font-mono text-[9px] mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            {reason}
          </div>
        )}

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
      </div>
    </div>
  );
}

function PipelineDetailPanelV3({ pipelineId }: { pipelineId: string }) {
  const { data: detail, isLoading, isError } = usePipelineDetail(pipelineId);

  if (isError) {
    return (
      <Card variant="elevated" className="p-5 col-span-full">
        <div className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load detail. Try again in a moment.
        </div>
      </Card>
    );
  }
  if (isLoading || !detail) {
    return (
      <Card variant="elevated" className="p-5 col-span-full">
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading detail…
        </div>
      </Card>
    );
  }

  const sparkData = (detail.sparkline ?? []).map(s => ({
    t: s.recorded_at.slice(11, 16),
    v: s.count,
  }));
  const fr = detail.failure_rate_24h;
  const lr = detail.last_run;

  return (
    <Card variant="elevated" className="p-5 col-span-full">
      {detail.description && (
        <div className="mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-base)' }}>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
            What this pipeline does
          </div>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {detail.description}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left — sparkline + drain rate (OR reference-dataset block) */}
        <div className="space-y-4">
          {detail.reference_dataset ? (
            <ReferenceDatasetBlock
              data={detail.reference_dataset}
              attempts={detail.recent_attempts ?? []}
            />
          ) : (
          <div>
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Backlog · last 24h
            </div>
            {sparkData.length > 1 ? (
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={sparkData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`pipeline-spark-${detail.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="var(--amber)" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="var(--amber)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="t"
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
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="var(--amber)"
                    strokeWidth={1.5}
                    fill={`url(#pipeline-spark-${detail.id})`}
                    name="Backlog"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Not enough samples yet
              </div>
            )}
          </div>
          )}

          {detail.drained_last_hour != null && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
                Drained · last hour
              </div>
              <div className="text-lg font-mono" style={{ color: 'var(--text-primary)' }}>
                {detail.drained_last_hour.toLocaleString()}
              </div>
            </div>
          )}

          {detail.why_grows && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
                Why this grows
              </div>
              <p className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {detail.why_grows}
              </p>
            </div>
          )}
        </div>

        {/* Right — failure-rate + last-run + endpoints */}
        <div className="space-y-4">
          {fr && fr.total > 0 && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
                Failure rate · 24h · {fr.total} runs
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Success" value={fr.success.toString()} tone="green" />
                <Stat label="Partial" value={fr.partial.toString()} tone={fr.partial > 0 ? 'sev-medium' : undefined} />
                <Stat label="Failed"  value={fr.failed.toString()}  tone={fr.failed  > 0 ? 'sev-high'   : undefined} />
              </div>
              <div
                className="font-mono text-[10px] mt-1.5"
                style={{ color: fr.pct >= 95 ? 'var(--green)' : fr.pct >= 80 ? 'var(--sev-medium)' : 'var(--sev-high)' }}
              >
                {fr.pct}% success
              </div>
            </div>
          )}

          {lr && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
                Last run
              </div>
              <div className="space-y-1 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                <div>Status: <span style={{ color: lr.status === 'success' ? 'var(--green)' : lr.status === 'failed' ? 'var(--sev-high)' : 'var(--text-primary)' }}>{lr.status}</span></div>
                <div>Started: {relativeTime(lr.started_at)}</div>
                {lr.duration_ms != null && <div>Duration: {formatDuration(lr.duration_ms)}</div>}
                {lr.records_processed != null && <div>Records: {lr.records_processed.toLocaleString()}</div>}
              </div>
              {lr.error_message && (
                <div className="font-mono text-[11px] mt-2 p-2 rounded" style={{
                  background: 'var(--sev-critical-bg)',
                  color:      'var(--text-primary)',
                  border:     '1px solid var(--sev-critical-border)',
                }}>
                  {lr.error_message}
                </div>
              )}
            </div>
          )}

          {detail.endpoints && detail.endpoints.length > 0 && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
                External endpoints
              </div>
              <div className="flex flex-wrap gap-1">
                {detail.endpoints.map(e => (
                  <span
                    key={e.url}
                    className="px-2 py-0.5 rounded font-mono text-[9px]"
                    style={{
                      background: 'var(--bg-input)',
                      color:      'var(--text-secondary)',
                      border:     '1px solid var(--border-base)',
                    }}
                    title={e.url}
                  >
                    {e.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function ReferenceDatasetBlock({
  data,
  attempts,
}: {
  data: NonNullable<PipelineDetail['reference_dataset']>;
  attempts: NonNullable<PipelineDetail['recent_attempts']>;
}) {
  const {
    configured, row_count, shadow_row_count, shadow_table_present,
    source_version, last_refresh_age_hours, last_refresh_status,
    last_refresh_duration_ms, last_refresh_error, currently_running,
    stale_threshold_days,
  } = data;

  const ageDays =
    last_refresh_age_hours != null ? last_refresh_age_hours / 24 : null;
  const ageLabel =
    last_refresh_age_hours == null
      ? 'never'
      : last_refresh_age_hours < 1
        ? 'just now'
        : last_refresh_age_hours < 24
          ? `${last_refresh_age_hours}h ago`
          : `${Math.round((ageDays ?? 0) * 10) / 10}d ago`;
  const ageColor =
    ageDays == null
      ? 'var(--text-muted)'
      : ageDays > stale_threshold_days * 2
        ? 'var(--sev-critical)'
        : ageDays > stale_threshold_days
          ? 'var(--sev-medium)'
          : 'var(--green)';

  const shortSha =
    source_version && source_version.length >= 12
      ? source_version.slice(0, 12)
      : source_version;

  const shadowPct =
    currently_running && shadow_row_count != null && row_count > 0
      ? Math.min(100, Math.round((shadow_row_count / row_count) * 100))
      : null;

  return (
    <div className="space-y-4">
      <div>
        <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
          Reference dataset
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Stat label="Live rows" value={row_count.toLocaleString()} />
          <div>
            <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>
              Age
            </div>
            <div className="text-lg font-mono" style={{ color: ageColor }}>
              {ageLabel}
            </div>
          </div>
        </div>
      </div>

      {!configured && (
        <div className="font-mono text-[10px] p-2 rounded" style={{
          background: 'var(--sev-medium-bg)',
          color:      'var(--text-secondary)',
          border:     '1px solid var(--border-base)',
        }}>
          GEOIP_DB not configured — bind the D1 database to enable enrichment.
        </div>
      )}

      {source_version && (
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
            Source release
          </div>
          <div
            className="font-mono text-[11px] mt-0.5"
            style={{ color: 'var(--text-primary)' }}
            title={source_version}
          >
            sha256:{shortSha}…
          </div>
        </div>
      )}

      {currently_running && (
        <div className="p-2 rounded" style={{
          background: 'var(--sev-low-bg)',
          border:     '1px solid var(--border-base)',
        }}>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--sev-low)' }}>
            Refresh in flight
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Shadow table populating
            {shadow_table_present && shadow_row_count != null && (
              <>: {shadow_row_count.toLocaleString()} rows {shadowPct != null && `(${shadowPct}%)`}</>
            )}
          </div>
        </div>
      )}

      {last_refresh_status === 'failed' && last_refresh_error && (
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--sev-critical)' }}>
            Last refresh failed
          </div>
          <div className="font-mono text-[11px] p-2 rounded" style={{
            background: 'var(--sev-critical-bg)',
            color:      'var(--text-primary)',
            border:     '1px solid var(--sev-critical-border)',
          }}>
            {last_refresh_error}
          </div>
        </div>
      )}

      {!currently_running && last_refresh_status === 'success' && last_refresh_duration_ms != null && (
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          Last import ran in {formatDuration(last_refresh_duration_ms)}.
        </div>
      )}

      {attempts.length > 0 && (
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Recent attempts
          </div>
          <div className="space-y-1">
            {attempts.slice(0, 5).map(a => {
              const color =
                a.status === 'success' ? 'var(--green)' :
                a.status === 'failed'  ? 'var(--sev-high)' :
                a.status === 'running' ? 'var(--sev-low)' :
                                         'var(--text-secondary)';
              return (
                <div
                  key={a.id}
                  className="flex items-center justify-between font-mono text-[10px]"
                  style={{ color: 'var(--text-secondary)' }}
                  title={a.error_message ?? undefined}
                >
                  <span style={{ color }}>{a.status}</span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {a.rows_written > 0 ? a.rows_written.toLocaleString() + ' rows · ' : ''}
                    {relativeTime(a.started_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'sev-high' | 'sev-medium' }) {
  const color =
    tone === 'green'      ? 'var(--green)' :
    tone === 'sev-high'   ? 'var(--sev-high)' :
    tone === 'sev-medium' ? 'var(--sev-medium)' :
                            'var(--text-primary)';
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-lg font-mono" style={{ color }}>{value}</div>
    </div>
  );
}

export function Pipelines({ agents }: { agents: Agent[] }) {
  const { data: pipelines = [] } = usePipelineStatus(agents);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (pipelines.length === 0) {
    return (
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        No pipelines registered.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {pipelines.map(p => {
        const agentData   = agents.find(a => a.name === p.agent);
        const agentStatus = agentData?.status ?? p.agent_last_status ?? 'idle';
        const isSelected  = selectedId === p.id;
        return (
          <Fragment key={p.id}>
            <PipelineCardV3
              pipeline={p}
              agentStatus={agentStatus}
              isSelected={isSelected}
              onSelect={() =>
                setSelectedId(prev => prev === p.id ? null : p.id)
              }
            />
            {isSelected && <PipelineDetailPanelV3 pipelineId={p.id} />}
          </Fragment>
        );
      })}
    </div>
  );
}
