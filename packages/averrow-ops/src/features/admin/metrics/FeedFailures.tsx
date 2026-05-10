// Feed Failures, v3 treatment for /admin/metrics.
//
// Significant data-shape overlap with /feeds — both render a
// per-feed view with verdict + failure stats. Decision: keep this
// tab as a FOCUSED 24h triage view distinct from /feeds:
//
//   - Filtered to AT-RISK feeds only (fail/warn verdicts + paused).
//     Healthy feeds are hidden — operator already knows those are
//     fine. Toggle to show all if needed.
//   - 24h-window-only stats (vs /feeds's all-time totals).
//   - Sorted by % to auto-pause threshold so the most urgent feed
//     reads first.
//   - Recent-errors stream as a separate panel — unique value-add
//     vs /feeds (which only shows last_error per feed; this
//     shows actual error messages with timestamps in chronological
//     order).
//   - Each feed card cross-links to /feeds for the full detail
//     + action buttons (Trigger / Pause / Resume).
//
// Same useFeedFailures hook → same data → same backend cost.

import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { ChevronDown, ExternalLink, AlertTriangle, Pause } from 'lucide-react';
import { useFeedFailures } from '@/hooks/useMetrics';
import type { FeedFailurePayload, FeedFailureRow } from '@/hooks/useMetrics';
import { relativeTime } from '@/lib/time';

export function FeedFailures() {
  const { data, isLoading, isError } = useFeedFailures();
  const [showAll, setShowAll] = useState(false);

  if (isError) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load feed-failure data. Try again in a moment.
        </p>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading feeds…
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Totals data={data} />
      <AtRiskGrid
        rows={data.per_feed}
        showAll={showAll}
        onToggleShowAll={() => setShowAll(prev => !prev)}
      />
      <RecentErrorsStream data={data} />
    </div>
  );
}

// ─── 24h totals strip ────────────────────────────────────────────
function Totals({ data }: { data: FeedFailurePayload }) {
  const t = data.totals_24h;
  const ratePct = t.total_pulls > 0
    ? Math.round((t.total_failed / t.total_pulls) * 100)
    : 0;
  const rateTone =
    ratePct >= 30 ? 'critical' :
    ratePct >= 10 ? 'high' :
                    'green';

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <Tile label="Pulls 24h"        value={t.total_pulls.toLocaleString()} />
      <Tile label="Successes"        value={t.total_success.toLocaleString()} accent="green" />
      <Tile label="Failures"         value={t.total_failed.toLocaleString()}  accent={t.total_failed > 0 ? 'sev-high' : undefined} />
      <Tile label="Failure rate"     value={`${ratePct}%`} accent={rateTone} />
      <Tile label="Active feeds"     value={t.feeds_active.toString()} />
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: 'green' | 'sev-high' | 'critical' | 'high' | 'green' }) {
  const color =
    accent === 'green'    ? 'var(--green)' :
    accent === 'critical' ? 'var(--sev-critical)' :
    accent === 'high'     ? 'var(--sev-high)' :
    accent === 'sev-high' ? 'var(--sev-high)' :
                            'var(--text-primary)';
  return (
    <Card variant="elevated" className="p-3">
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="font-display text-2xl font-bold" style={{ color }}>
        {value}
      </div>
    </Card>
  );
}

// ─── At-risk grid ────────────────────────────────────────────────
type Tone = 'critical' | 'high' | 'green' | 'muted';
function tierFor(row: FeedFailureRow): Tone {
  if (row.paused_reason === 'auto:consecutive_failures') return 'critical';
  if (!row.enabled || row.paused_reason)                  return 'muted';
  if (row.pct_to_auto_pause >= 80)                        return 'critical';
  if (row.pct_to_auto_pause >= 60)                        return 'high';
  if (row.failure_rate_pct >= 30 && row.pulls >= 10)      return 'high';
  return 'green';
}
function isAtRisk(row: FeedFailureRow): boolean {
  const tier = tierFor(row);
  return tier === 'critical' || tier === 'high' || tier === 'muted';
}

function AtRiskGrid({
  rows, showAll, onToggleShowAll,
}: {
  rows: FeedFailureRow[];
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const list = showAll ? rows : rows.filter(isAtRisk);
    // Re-sort: closest to auto-pause first, then by failure rate
    return [...list].sort((a, b) => {
      if (b.pct_to_auto_pause !== a.pct_to_auto_pause) return b.pct_to_auto_pause - a.pct_to_auto_pause;
      return b.failure_rate_pct - a.failure_rate_pct;
    });
  }, [rows, showAll]);

  const atRiskCount = rows.filter(isAtRisk).length;

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
            {showAll ? 'All feeds' : 'At-risk feeds'}
          </div>
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            {showAll
              ? `Showing all ${rows.length} feeds (${atRiskCount} at risk)`
              : `Filtered to feeds with failures, paused, or near auto-pause`}
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleShowAll}
          className="px-2.5 py-1 font-mono text-[10px] tracking-[0.18em] uppercase rounded transition-colors"
          style={{
            background: 'var(--bg-input)',
            border:     '1px solid var(--border-base)',
            color:      'var(--text-secondary)',
          }}
        >
          {showAll ? `Hide healthy` : `Show all (${rows.length})`}
        </button>
      </div>

      {filtered.length === 0 ? (
        <Card variant="elevated" className="p-4">
          <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {showAll
              ? 'No feeds configured.'
              : 'No feeds at risk. Toggle "Show all" to see healthy feeds.'}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(row => {
            const isSel = selected === row.feed_name;
            return (
              <Fragment key={row.feed_name}>
                <FeedRiskCard
                  row={row}
                  isSelected={isSel}
                  onSelect={() => setSelected(prev => prev === row.feed_name ? null : row.feed_name)}
                />
                {isSel && <FeedRiskDetail row={row} />}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function tierColor(t: Tone): string {
  if (t === 'critical') return 'var(--sev-critical)';
  if (t === 'high')     return 'var(--sev-high)';
  if (t === 'green')    return 'var(--green)';
  return 'var(--text-muted)';
}

function FeedRiskCard({
  row, isSelected, onSelect,
}: {
  row:        FeedFailureRow;
  isSelected: boolean;
  onSelect:   () => void;
}) {
  const tier = tierFor(row);
  const variant: 'elevated' | 'critical' = tier === 'critical' ? 'critical' : 'elevated';
  const barColor = tierColor(tier);
  const isPaused = !row.enabled || !!row.paused_reason;

  // Headline label — pick the most useful single fact.
  const headline =
    row.paused_reason === 'auto:consecutive_failures' ? 'Auto-paused' :
    row.paused_reason === 'manual'                    ? 'Manually paused' :
    !row.enabled                                      ? 'Disabled' :
    row.pct_to_auto_pause >= 80                       ? `${row.pct_to_auto_pause}% to auto-pause` :
    row.failure_rate_pct >= 30                        ? `${row.failure_rate_pct}% failure rate` :
    row.consecutive_failures > 0                      ? `${row.consecutive_failures} consecutive failures` :
                                                        'Healthy';

  return (
    <Card
      variant={variant}
      className="p-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <div
          className="flex-shrink-0 w-7 h-7 rounded-md grid place-items-center"
          style={{
            background: 'var(--bg-input)',
            color:      isPaused ? 'var(--sev-high)' : tier === 'critical' || tier === 'high' ? 'var(--sev-high)' : 'var(--blue)',
          }}
        >
          {isPaused
            ? <Pause size={12} />
            : <AlertTriangle size={12} />}
        </div>
        <span className="font-mono text-[12px] font-bold uppercase tracking-wide truncate flex-1" style={{ color: 'var(--text-primary)' }}>
          {row.display_name || row.feed_name}
        </span>
        <Badge status={row.verdict.tone} label={row.verdict.label} size="xs" />
        <ChevronDown
          size={12}
          style={{
            color:      'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </div>

      {/* Headline reason text */}
      <div
        className="font-mono text-[11px] mb-2"
        style={{ color: tier === 'critical' || tier === 'high' ? barColor : 'var(--text-secondary)' }}
      >
        {headline}
      </div>

      {/* % to auto-pause bar — most actionable risk metric */}
      {!isPaused && row.pct_to_auto_pause > 0 && (
        <div className="mb-2">
          <div
            className="rounded-full overflow-hidden"
            style={{ height: 3, background: 'var(--border-base)' }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, row.pct_to_auto_pause)}%`,
                background: barColor,
              }}
            />
          </div>
          <div className="font-mono text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {row.consecutive_failures} / {row.threshold} consecutive failures → auto-pause
          </div>
        </div>
      )}

      {/* Mini-stats */}
      <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
        <Mini label="PULLS"   value={row.pulls.toLocaleString()} />
        <Mini label="FAIL"    value={row.failed.toString()} tone={row.failed > 0 ? 'sev-high' : undefined} />
        <Mini label="RATE"    value={`${row.failure_rate_pct}%`} tone={row.failure_rate_pct >= 30 ? 'sev-high' : undefined} />
      </div>
    </Card>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: 'sev-high' | 'green' }) {
  const color = tone === 'sev-high' ? 'var(--sev-high)' : tone === 'green' ? 'var(--green)' : 'var(--text-primary)';
  return (
    <div>
      <div style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ color }}>{value}</div>
    </div>
  );
}

function FeedRiskDetail({ row }: { row: FeedFailureRow }) {
  return (
    <Card variant="elevated" className="p-4 col-span-full">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <Stat label="24h pulls"       value={row.pulls.toLocaleString()} />
        <Stat label="Successes"       value={row.success.toString()} tone="green" />
        <Stat label="Failures"        value={row.failed.toString()} tone={row.failed > 0 ? 'sev-high' : undefined} />
        <Stat label="Partial"         value={row.partial.toString()} tone={row.partial > 0 ? 'sev-medium' : undefined} />
        <Stat label="Failure rate"    value={`${row.failure_rate_pct}%`} tone={row.failure_rate_pct >= 30 ? 'sev-high' : undefined} />
        <Stat label="Records ingested" value={row.records_ingested.toLocaleString()} />
        <Stat label="Conseq. failures" value={`${row.consecutive_failures} / ${row.threshold}`} tone={row.consecutive_failures > 0 ? 'sev-high' : undefined} />
        <Stat label="% to auto-pause" value={`${row.pct_to_auto_pause}%`} tone={row.pct_to_auto_pause >= 80 ? 'sev-high' : row.pct_to_auto_pause >= 60 ? 'sev-medium' : undefined} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
            Last success
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {row.last_success_at ? relativeTime(row.last_success_at) : 'Never in 24h'}
          </div>
        </div>
        <div>
          <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--sev-high)' }}>
            Last failure
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {row.last_failure_at ? relativeTime(row.last_failure_at) : 'None in 24h'}
          </div>
        </div>
      </div>

      <Link
        to="/feeds"
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded font-mono text-[10px] tracking-[0.12em] uppercase transition-colors"
        style={{
          background: 'var(--amber-glow)',
          color:      'var(--amber)',
          border:     '1px solid var(--amber-border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        Open in /feeds for full detail + actions
        <ExternalLink size={12} />
      </Link>
    </Card>
  );
}

// ─── Recent errors stream ────────────────────────────────────────
//
// Unique to this view — /feeds only shows last_error per feed.
// Here we get a chronological feed of error messages across all
// feeds in the last 24h, useful for spotting patterns ("3 different
// feeds all started failing 2h ago — common cause?").
function RecentErrorsStream({ data }: { data: FeedFailurePayload }) {
  const errors = data.recent_errors;

  if (errors.length === 0) {
    return (
      <div className="space-y-2">
        <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
          Recent errors · 24h
        </div>
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No feed errors recorded in the last 24h.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
            Recent errors · 24h
          </div>
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            Chronological feed of failed-pull error messages across all feeds
          </div>
        </div>
        <span
          className="font-mono text-[10px] px-2 py-0.5 rounded"
          style={{
            background: 'var(--bg-input)',
            color:      'var(--text-secondary)',
            border:     '1px solid var(--border-base)',
          }}
        >
          {errors.length}
        </span>
      </div>
      <Card variant="elevated" className="p-4">
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {errors.map((err, i) => (
            <div
              key={`${err.feed_name}-${err.started_at}-${i}`}
              className="flex items-start gap-3 py-1.5 border-b last:border-b-0"
              style={{ borderColor: 'var(--border-base)' }}
            >
              <span
                className="font-mono text-[10px] flex-shrink-0 mt-0.5"
                style={{ color: 'var(--text-tertiary)', minWidth: 64 }}
              >
                {relativeTime(err.started_at)}
              </span>
              <span
                className="font-mono text-[10px] font-bold flex-shrink-0 mt-0.5"
                style={{ color: 'var(--text-primary)', minWidth: 100 }}
                title={err.feed_name}
              >
                {err.feed_name}
              </span>
              <span
                className="font-mono text-[11px] flex-1 break-words"
                style={{ color: 'var(--sev-high)' }}
              >
                {err.error_message}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'sev-high' | 'sev-medium' }) {
  const color =
    tone === 'green'      ? 'var(--green)' :
    tone === 'sev-high'   ? 'var(--sev-high)' :
    tone === 'sev-medium' ? 'var(--sev-medium)' :
                            'var(--text-primary)';
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-base font-mono" style={{ color }}>{value}</div>
    </div>
  );
}
