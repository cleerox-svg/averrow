// Feed Failures — Metrics page section 5.
//
// Sortable table of every feed in feed_configs (plus any orphan
// feeds that have history rows without a config) with a 24h pull
// count, success / failed / partial split, failure-rate %, and
// auto-pause risk surfaced from feed_status.consecutive_failures
// vs feed_configs.consecutive_failure_threshold.
//
// Backend sorts by verdict severity so the operator's first-glance
// problem is at the top of the table.

import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { useFeedFailures, type FeedFailurePayload, type FeedFailureRow } from '@/hooks/useMetrics';
import { relativeTime } from '@/lib/time';
import { MetricsTile } from './MetricsTile';

export function FeedFailuresSection() {
  const { data, isLoading, isError } = useFeedFailures();

  return (
    <Card style={{ padding: '16px' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="section-label font-mono font-bold">Feed Failures</span>
        {data && (
          <span
            className="font-mono text-[9px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            last 24h
          </span>
        )}
      </div>

      {isError ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load feed-failure data. Try again in a moment.
        </p>
      ) : isLoading || !data ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading feeds…
        </p>
      ) : (
        <div className="space-y-4">
          <Totals data={data} />
          <FeedTable rows={data.per_feed} />
          <RecentErrors data={data} />
        </div>
      )}
    </Card>
  );
}

// ─── Headline tiles ──────────────────────────────────────────────
function Totals({ data }: { data: FeedFailurePayload }) {
  const t = data.totals_24h;
  const ratePct = t.total_pulls > 0
    ? Math.round((t.total_failed / t.total_pulls) * 100)
    : 0;
  // Failure rate carries the threshold tone (≥30% red, ≥10% amber);
  // active-feeds tile turns green when >0 (positive signal); the
  // remaining tiles stay neutral so the eye lands on the failure
  // rate first.
  const failureTone: import('./MetricsTile').MetricsTone =
    ratePct >= 30 ? 'failed' : ratePct >= 10 ? 'warning' : 'success';
  const tiles: Array<{
    label: string;
    value: string;
    tone: import('./MetricsTile').MetricsTone;
  }> = [
    { label: 'Pulls (24h)',     value: t.total_pulls.toLocaleString(),    tone: 'default' },
    { label: 'Failures',        value: t.total_failed.toLocaleString(),   tone: t.total_failed > 0 ? 'failed' : 'default' },
    { label: 'Failure rate',    value: `${ratePct}%`,                     tone: failureTone },
    { label: 'Records ingested', value: formatBig(t.total_records),       tone: 'default' },
    { label: 'Active feeds',    value: t.feeds_active.toLocaleString(),   tone: t.feeds_active > 0 ? 'success' : 'default' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
      {tiles.map((tile) => (
        <MetricsTile key={tile.label} label={tile.label} tone={tile.tone}>
          <div className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            {tile.value}
          </div>
        </MetricsTile>
      ))}
    </div>
  );
}

// ─── Per-feed table ──────────────────────────────────────────────
function FeedTable({ rows }: { rows: FeedFailureRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        No feeds configured.
      </p>
    );
  }
  return (
    <div>
      <Header label="Per feed (sorted by severity)" />
      <ul className="space-y-0.5">
        {rows.map((r) => <FeedRow key={r.feed_name} row={r} />)}
      </ul>
    </div>
  );
}

function FeedRow({ row }: { row: FeedFailureRow }) {
  const verdictTitle = `${row.success} ok · ${row.failed} failed · ${row.partial} partial / ${row.pulls} pulls`;
  return (
    <li className="flex items-center gap-3 py-1.5 border-b border-white/[0.04]">
      <Badge status={row.verdict.tone} label={row.verdict.label} size="xs" />
      <div className="flex-1 min-w-0">
        <div
          className="font-mono text-[11px] font-bold truncate"
          style={{ color: 'var(--text-primary)' }}
          title={row.feed_name}
        >
          {row.display_name}
        </div>
        <div
          className="font-mono text-[9px] truncate"
          style={{ color: 'var(--text-muted)' }}
        >
          {row.pulls === 0
            ? 'no pulls in last 24h'
            : verdictTitle}
          {row.last_failure_at ? (
            <>
              {' · '}last fail {relativeTime(row.last_failure_at)}
            </>
          ) : null}
          {row.paused_reason ? (
            <>
              {' · '}{row.paused_reason}
            </>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span
          className="font-mono text-[10px] font-bold w-10 text-right"
          style={{
            color: row.failure_rate_pct >= 30
              ? 'var(--sev-critical)'
              : row.failure_rate_pct >= 10
                ? 'var(--sev-medium)'
                : row.failure_rate_pct > 0
                  ? 'var(--text-secondary)'
                  : 'var(--text-muted)',
          }}
          title="24h failure rate"
        >
          {row.failure_rate_pct}%
        </span>
        {row.threshold > 0 && (
          <div
            className="rounded-full overflow-hidden shrink-0"
            style={{
              width: 50,
              height: 4,
              background: 'rgba(255,255,255,0.06)',
            }}
            title={`${row.consecutive_failures} consecutive failures · ${row.pct_to_auto_pause}% to auto-pause threshold (${row.threshold})`}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, row.pct_to_auto_pause)}%`,
                background: row.pct_to_auto_pause >= 80
                  ? 'var(--sev-critical)'
                  : row.pct_to_auto_pause >= 60
                    ? 'var(--sev-medium)'
                    : 'var(--text-muted)',
              }}
            />
          </div>
        )}
      </div>
    </li>
  );
}

// ─── Recent error log ────────────────────────────────────────────
function RecentErrors({ data }: { data: FeedFailurePayload }) {
  if (data.recent_errors.length === 0) return null;
  return (
    <div>
      <Header label="Recent errors (last 10 failed pulls)" />
      <ul className="space-y-1">
        {data.recent_errors.map((e, i) => (
          <li
            key={`${e.feed_name}-${i}`}
            className="flex items-baseline gap-3 py-1 border-b border-white/[0.04]"
          >
            <span
              className="font-mono text-[10px] font-bold shrink-0"
              style={{ color: 'var(--sev-critical)', minWidth: 90 }}
              title={e.feed_name}
            >
              {e.feed_name}
            </span>
            <span
              className="font-mono text-[9px] shrink-0"
              style={{ color: 'var(--text-muted)', minWidth: 70 }}
            >
              {relativeTime(e.started_at)}
            </span>
            <span
              className="font-mono text-[10px] flex-1 line-clamp-2"
              style={{ color: 'var(--text-secondary)' }}
              title={e.error_message}
            >
              {e.error_message}
            </span>
          </li>
        ))}
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
