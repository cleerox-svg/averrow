// Pipeline Automation — moved from features/agents/Agents.tsx into
// features/admin/metrics/ as part of the new /admin/metrics page.
//
// Two public exports:
//   - PipelineAutomationSection — the full grid + legend modal + drill-
//                                 down detail sheet. Used by the
//                                 Metrics page.
//   - PipelineAutomationSummaryStrip — a compact one-row summary that
//                                 stays on the Agents page and links to
//                                 /admin/metrics. Lets a triaging
//                                 operator scan agents + pipelines
//                                 from the same page without losing the
//                                 dedicated drill surface.
//
// Everything below is a verbatim lift from Agents.tsx — same helpers,
// same components, same behavior. The split lets the Metrics page own
// the rich UI while Agents keeps a tight summary.

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import type { VerdictTag } from '@/components/ui/Badge';

/**
 * Map a verdict label string (e.g. "CLEAR", "DRAINING") from the
 * pipeline-status API to the Badge.verdict tag (Bundle C session 1).
 * Returns undefined for unknown labels — caller falls back to the
 * legacy status+label rendering so unknown shapes still render.
 */
function labelToVerdict(label?: string): VerdictTag | undefined {
  const v = label?.toLowerCase();
  if (
    v === 'clear' || v === 'draining' || v === 'steady' ||
    v === 'growing' || v === 'stale' || v === 'updated' || v === 'stable'
  ) return v;
  return undefined;
}
import { useGeoipRefresh } from '@/hooks/useGeoipRefresh';
import { usePipelineStatus, usePipelineDetail } from '@/hooks/useAgents';
import type { Agent, PipelineEntry } from '@/hooks/useAgents';
import { relativeTime, formatDuration } from '@/lib/time';
import { cn } from '@/lib/cn';

// ─── Helpers ────────────────────────────────────────────────────────

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

// ─── GeoIP Refresh Action ───────────────────────────────────────────
//
// Trigger a GeoIP refresh from the Pipeline Automation tile.
// Two affordances:
//   - "Refresh" : poll MaxMind and re-import IFF a new release shipped
//   - "Force"   : bypass the skip-if-current guard (after schema
//                 changes, partial loads, or initial bootstrap when
//                 source_version is null and we still want a load)
//
// Gated to the geoip pipeline only — other tiles don't have a
// meaningful "trigger now" action because they're driven by feed
// cadence, not on-demand work.
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

// ─── Detail row helper ─────────────────────────────────────────────
function PipelineDetailRow({
  k,
  v,
  vTone,
  truncate,
}: {
  k: string;
  v: string;
  vTone?: 'normal' | 'warning' | 'critical';
  truncate?: boolean;
}) {
  const valueColor =
    vTone === 'critical' ? 'var(--sev-critical)'
      : vTone === 'warning' ? 'var(--sev-medium)'
        : 'var(--text-primary)';
  return (
    <div className="flex items-start justify-between gap-3 py-1 border-b border-white/[0.04]">
      <span
        className="font-mono text-[9px] uppercase tracking-wider shrink-0"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {k}
      </span>
      <span
        className={cn('font-mono text-[10px] text-right', truncate && 'line-clamp-2')}
        style={{ color: valueColor }}
        title={truncate ? v : undefined}
      >
        {v}
      </span>
    </div>
  );
}

// ─── Drill-down detail sheet ───────────────────────────────────────
function PipelineDetailSheet({
  pipelineId,
  onClose,
}: {
  pipelineId: string | null;
  onClose: () => void;
}) {
  const { data: detail, isLoading, isError } = usePipelineDetail(pipelineId);
  if (!pipelineId) return null;

  const sparkData = (detail?.sparkline ?? []).map((s) => ({
    t: s.recorded_at.slice(11, 16),
    v: s.count,
  }));

  return (
    <div
      role="dialog"
      aria-label={detail ? `${detail.label} — pipeline details` : 'Pipeline details'}
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl max-w-lg w-full max-h-[88vh] overflow-y-auto"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-base)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5">
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0">
              <div
                className="font-mono text-[9px] uppercase tracking-[0.22em]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Pipeline · {detail?.id ?? pipelineId}
              </div>
              <div
                className="font-display text-base font-bold mt-0.5 truncate"
                style={{ color: 'var(--text-primary)' }}
              >
                {detail?.label ?? '…'}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-[12px] px-2 py-1 rounded hover:bg-white/[0.06]"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label="Close detail"
            >
              ✕
            </button>
          </div>

          {isError ? (
            <div className="font-mono text-[10px] py-3" style={{ color: 'var(--sev-critical)' }}>
              Failed to load detail. Try again in a moment.
            </div>
          ) : isLoading || !detail ? (
            <div className="font-mono text-[10px] py-3" style={{ color: 'var(--text-muted)' }}>
              Loading detail…
            </div>
          ) : (
            <>
              {detail.description && (
                <p
                  className="font-mono text-[11px] leading-relaxed mb-3"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {detail.description}
                </p>
              )}

              <div className="flex items-baseline gap-2 mb-3">
                <span
                  className="font-display text-2xl font-bold"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {detail.count != null ? detail.count.toLocaleString() : '—'}
                </span>
                {(() => {
                  const v = labelToVerdict(detail.verdict.label);
                  return v
                    ? <Badge verdict={v} size="xs" />
                    : <Badge status={detail.verdict.tone} label={detail.verdict.label} size="xs" />;
                })()}
                {detail.drained_last_hour != null && detail.drained_last_hour !== 0 && (
                  <span
                    className="font-mono text-[10px]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    · {detail.drained_last_hour > 0 ? 'drained' : 'grew'}{' '}
                    {Math.abs(detail.drained_last_hour).toLocaleString()} in last hour
                  </span>
                )}
              </div>

              {sparkData.length > 1 && (
                <div className="mb-3" style={{ height: 80 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={sparkData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="pdSparkFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--amber)" stopOpacity={0.45} />
                          <stop offset="100%" stopColor="var(--amber)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="t" tick={{ fontSize: 8, fill: 'rgba(255,255,255,0.30)' }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                      <YAxis hide />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--bg-card)',
                          border: '1px solid var(--border-base)',
                          borderRadius: 6,
                          fontSize: 10,
                        }}
                        labelStyle={{ color: 'var(--text-secondary)' }}
                      />
                      <Area
                        type="monotone"
                        dataKey="v"
                        stroke="var(--amber)"
                        strokeWidth={1.5}
                        fill="url(#pdSparkFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                  <div
                    className="font-mono text-[8px] uppercase tracking-wider mt-0.5"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Last 24h
                  </div>
                </div>
              )}

              <PipelineDetailRow k="Owning agent" v={detail.agent} />
              <PipelineDetailRow k="Schedule" v={detail.schedule} />
              {detail.last_run && (
                <PipelineDetailRow
                  k="Last run"
                  v={
                    `${detail.last_run.status}` +
                    (detail.last_run.records_processed != null
                      ? ` · ${detail.last_run.records_processed.toLocaleString()} rec`
                      : '') +
                    (detail.last_run.duration_ms != null
                      ? ` · ${formatDuration(detail.last_run.duration_ms)}`
                      : '') +
                    ` · ${relativeTime(detail.last_run.started_at)}`
                  }
                />
              )}
              {detail.failure_rate_24h && (
                <PipelineDetailRow
                  k="Failure rate (24h)"
                  v={`${detail.failure_rate_24h.pct}% (${detail.failure_rate_24h.failed}/${detail.failure_rate_24h.total} pulls)`}
                  vTone={
                    detail.failure_rate_24h.pct >= 30
                      ? 'critical'
                      : detail.failure_rate_24h.pct >= 10
                        ? 'warning'
                        : 'normal'
                  }
                />
              )}
              {detail.last_run?.error_message && (
                <PipelineDetailRow
                  k="Last error"
                  v={detail.last_run.error_message}
                  vTone="critical"
                  truncate
                />
              )}

              {detail.why_grows && (
                <div
                  className="mt-4 p-3 rounded-md"
                  style={{
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid var(--border-base)',
                  }}
                >
                  <div
                    className="font-mono text-[9px] uppercase tracking-[0.22em] mb-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Why does this grow?
                  </div>
                  <p
                    className="font-mono text-[11px] leading-relaxed"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {detail.why_grows}
                  </p>
                </div>
              )}

              {detail.endpoints && detail.endpoints.length > 0 && (
                <div className="mt-3">
                  <div
                    className="font-mono text-[9px] uppercase tracking-[0.22em] mb-1.5"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    External endpoints
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {detail.endpoints.map((e) => (
                      <a
                        key={e.url}
                        href={e.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[9px] px-2 py-1 rounded transition-colors hover:bg-white/[0.05]"
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
                </div>
              )}

              {detail.id === 'geoip' && (
                <div className="mt-4">
                  <GeoipRefreshAction />
                </div>
              )}

              {detail.id === 'geoip' && detail.recent_attempts && detail.recent_attempts.length > 0 && (
                <div className="mt-4">
                  <div
                    className="font-mono text-[9px] uppercase tracking-[0.22em] mb-1.5"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Recent refresh attempts
                  </div>
                  <ul className="space-y-1">
                    {detail.recent_attempts.map((a) => (
                      <li
                        key={a.id}
                        className="font-mono text-[10px] flex items-baseline gap-2"
                      >
                        <Badge
                          status={
                            a.status === 'success' ? 'success'
                              : a.status === 'failed' ? 'failed'
                                : a.status === 'running' ? 'running'
                                  : 'inactive'
                          }
                          label={a.status}
                          size="xs"
                        />
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {relativeTime(a.started_at)}
                          {a.rows_written > 0 && ` · ${a.rows_written.toLocaleString()} rows`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── First-time legend modal ───────────────────────────────────────
const PIPELINE_LEGEND_KEY = 'seen-pipeline-legend-v1';
function PipelineLegendModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  // Use the dedicated Badge.verdict tags from the design system
  // (Bundle C session 1) — gives each pipeline state its own
  // semantic color rather than reusing BadgeStatus tones with
  // overridden labels. R8 migration.
  type VerdictKey = 'clear' | 'draining' | 'steady' | 'growing' | 'stale' | 'updated' | 'stable';
  const rows: Array<{ verdict: VerdictKey; meaning: string }> = [
    { verdict: 'clear',    meaning: 'No items in this backlog right now.' },
    { verdict: 'draining', meaning: 'Backlog shrank since the last measurement — pipeline is keeping up.' },
    { verdict: 'steady',   meaning: 'Backlog is flat — inflow ≈ throughput.' },
    { verdict: 'growing',  meaning: 'Backlog grew since the last measurement — pipeline is falling behind.' },
    { verdict: 'stale',    meaning: 'No measurement in the last cycle. Watch for the next data point.' },
    { verdict: 'updated',  meaning: 'Reference dataset (e.g. GeoIP) was refreshed since last check.' },
    { verdict: 'stable',   meaning: 'Reference dataset is loaded and unchanged — healthy steady state.' },
  ];
  return (
    <div
      role="dialog"
      aria-label="Pipeline Automation legend"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl max-w-md w-full"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-base)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5">
          <div className="flex items-start justify-between mb-3">
            <span
              className="font-mono text-[10px] font-bold uppercase tracking-[0.22em]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Pipeline Automation · Legend
            </span>
            <button
              type="button"
              onClick={onClose}
              className="font-mono text-[11px] px-2 py-1 rounded hover:bg-white/[0.06]"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label="Close legend"
            >
              ✕
            </button>
          </div>
          <p
            className="font-mono text-[11px] leading-relaxed mb-4"
            style={{ color: 'var(--text-secondary)' }}
          >
            Each card is one enrichment pipeline. The big number is the
            current backlog (or row count for reference datasets). The
            verdict pill tells you health at a glance:
          </p>
          <div className="space-y-1.5 mb-4">
            {rows.map((r) => (
              <div key={r.verdict} className="flex items-center gap-3">
                <Badge verdict={r.verdict} size="xs" />
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  {r.meaning}
                </span>
              </div>
            ))}
          </div>
          <p
            className="font-mono text-[10px] leading-relaxed"
            style={{ color: 'var(--text-muted)' }}
          >
            The colored top border on each card mirrors the verdict tone
            so you can scan the grid for trouble spots. Tap a card for
            owning agent + last-run details.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Public: full grid (used by the Metrics page) ──────────────────
export function PipelineAutomationSection({ agents }: { agents: Agent[] }) {
  const { data: pipelines } = usePipelineStatus(agents);
  const [legendOpen, setLegendOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Auto-open legend the very first time. Crash-safe if storage is
  // disabled.
  useEffect(() => {
    try {
      if (!localStorage.getItem(PIPELINE_LEGEND_KEY)) {
        setLegendOpen(true);
        localStorage.setItem(PIPELINE_LEGEND_KEY, '1');
      }
    } catch { /* private mode / disabled storage — silently skip */ }
  }, []);

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
      <PipelineLegendModal open={legendOpen} onClose={() => setLegendOpen(false)} />
      <PipelineDetailSheet pipelineId={detailId} onClose={() => setDetailId(null)} />
      <div className="flex items-center gap-2 mb-3">
        <span className="section-label font-mono font-bold">Pipeline Automation</span>
        <button
          type="button"
          onClick={() => setLegendOpen(true)}
          className="font-mono text-[10px] w-4 h-4 rounded-full inline-flex items-center justify-center transition-colors hover:bg-white/[0.08]"
          style={{
            color: 'var(--text-tertiary)',
            border: '1px solid var(--border-base)',
          }}
          aria-label="What do these cards mean?"
          title="What do these cards mean?"
        >
          i
        </button>
      </div>
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
              role="button"
              tabIndex={0}
              onClick={() => setDetailId(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setDetailId(p.id);
                }
              }}
              className="rounded-lg overflow-hidden cursor-pointer transition-transform hover:scale-[1.01]"
              style={{
                background: 'rgba(22,30,48,0.50)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: `1px solid ${borderColor}`,
                borderTop: `3px solid ${topBorderColor}`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 4px 24px rgba(0,0,0,0.40)',
              }}
              aria-label={`Open ${p.label} details`}
            >
              <div className="p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-[10px] font-bold truncate" style={{ color: 'var(--text-primary)' }}>
                    {p.label}
                  </span>
                  <Badge
                    status={agentStatusLabel(agentStatus)}
                    label={p.agent}
                    size="xs"
                    pulse={agentStatus === 'active'}
                  />
                </div>

                {p.description ? (
                  <div
                    className="font-mono text-[9px] leading-snug mb-2 line-clamp-2"
                    style={{ color: 'var(--text-tertiary)' }}
                    title={p.description}
                  >
                    {p.description}
                  </div>
                ) : null}

                <div className="flex items-baseline gap-2 mb-1.5">
                  <span
                    className="font-display text-lg font-bold"
                    style={{ color: 'var(--text-primary)', lineHeight: 1 }}
                  >
                    {p.count.toLocaleString()}
                  </span>
                  {p.verdict ? (
                    (() => {
                      const v = labelToVerdict(p.verdict.label);
                      return v
                        ? <Badge verdict={v} size="xs" />
                        : <Badge status={p.verdict.tone} label={p.verdict.label} size="xs" />;
                    })()
                  ) : p.trend !== null && p.trend !== 0 ? (
                    <span
                      className="font-mono text-[10px] font-bold"
                      style={{ color: trendColor(p.trend_direction) }}
                    >
                      {trendArrow(p.trend_direction)} {Math.abs(p.trend).toLocaleString()}
                    </span>
                  ) : null}
                </div>

                {p.trend !== null && p.trend !== 0 ? (
                  <div
                    className="font-mono text-[9px] mb-1"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {trendArrow(p.trend_direction)} {Math.abs(p.trend).toLocaleString()} since last cycle
                  </div>
                ) : null}

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

                {p.endpoints && p.endpoints.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-white/[0.04] flex flex-wrap gap-1">
                    {p.endpoints.map((e) => (
                      <a
                        key={e.url}
                        href={e.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(ev) => ev.stopPropagation()}
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

                {p.id === 'geoip' && (
                  <div onClick={(e) => e.stopPropagation()}>
                    <GeoipRefreshAction />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Public: compact summary strip (kept on Agents page) ────────────
//
// Rolls the pipeline grid up into a single Card that shows aggregate
// health at a glance — total pipelines, growing / steady / draining
// counts — and links to /admin/metrics for the full grid + detail.
// Lets a triaging operator see "are any pipelines unhealthy?" without
// scrolling, then jump to Metrics for the deep dive.
export function PipelineAutomationSummaryStrip({ agents }: { agents: Agent[] }) {
  const { data: pipelines } = usePipelineStatus(agents);
  const items = Array.isArray(pipelines) ? pipelines : [];

  // Derive aggregate counts from the verdict tone palette.
  const counts = items.reduce(
    (acc, p) => {
      const tone = p.verdict?.tone ?? 'inactive';
      if (tone === 'failed')   acc.unhealthy++;
      else if (tone === 'success') acc.healthy++;
      else if (tone === 'pending') acc.stale++;
      else                     acc.steady++;
      return acc;
    },
    { healthy: 0, steady: 0, unhealthy: 0, stale: 0 },
  );

  const isLoading = items.length === 0;

  return (
    <Link
      to="/admin/metrics"
      className="block transition-transform hover:scale-[1.005]"
      aria-label="Open Metrics — Pipeline Automation"
    >
      <Card style={{ padding: '14px 16px' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="section-label font-mono font-bold">Pipeline Automation</span>
            <span
              className="font-mono text-[9px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              · {items.length} pipelines
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isLoading ? (
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Loading…
              </span>
            ) : (
              <>
                {counts.unhealthy > 0 && (
                  <Badge status="failed"   label={`${counts.unhealthy} growing`} size="xs" />
                )}
                {counts.healthy > 0 && (
                  <Badge status="success"  label={`${counts.healthy} draining`} size="xs" />
                )}
                {counts.steady > 0 && (
                  <Badge status="inactive" label={`${counts.steady} steady`}    size="xs" />
                )}
                {counts.stale > 0 && (
                  <Badge status="pending"  label={`${counts.stale} stale`}      size="xs" />
                )}
              </>
            )}
            <span
              className="font-mono text-[10px] shrink-0"
              style={{ color: 'var(--amber)' }}
            >
              View Metrics →
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
