// /feeds-v3 — preview surface for the next-gen Feeds page.
//
// First scaffold mirrors the agents-v3 first-cut pattern: real data
// from useFeeds (parity with /feeds), the toggle in the page header,
// a v3 preview banner identifying what's experimental, and the bones
// of the new layout (stats grid + feed cards).
//
// What's experimental in v3 (vs v2):
//   - Failure-pattern badge per feed (auto-paused, high failure
//     rate, ingestion-stuck), derived from existing FeedOverview
//     fields without new backend data
//   - Decommission heuristic: feeds with >10 pulls and 0 ingested
//     OR no successful pull in 14d
//   - Compact card grid focused on at-a-glance triage rather than
//     the dense detail-table of v2
//
// Iterate from screenshots — the /agents-v3 work followed the same
// pattern (ship blank shell, gather feedback, fill in surfaces).

import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFeeds, useFeedStats, useFeedHistory } from '@/hooks/useFeeds';
import type { FeedOverview, FeedPullRecord } from '@/hooks/useFeeds';
import {
  Card, StatCard, StatGrid, PageHeader,
} from '@/design-system/components';
import { VersionToggle } from '@/components/ui/VersionToggle';
import { Badge } from '@/components/ui/Badge';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { CardGridLoader } from '@/components/ui/PageLoader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Rss, AlertTriangle, ChevronDown, Pause, Activity, Clock } from 'lucide-react';

// Same humanizer used by /feeds — keep them in sync if the v2 list
// gains new entries. (We could lift to a shared util once a third
// caller appears.)
const CRON_LABEL: Record<string, string> = {
  '*/5 * * * *':   'Every 5 min',
  '*/15 * * * *':  'Every 15 min',
  '*/30 * * * *':  'Every 30 min',
  '0 * * * *':     'Hourly',
  '0 */2 * * *':   'Every 2 h',
  '0 */4 * * *':   'Every 4 h',
  '0 */6 * * *':   'Every 6 h',
  '0 */12 * * *':  'Every 12 h',
  '0 0 * * *':     'Daily',
  '0 0 * * 0':     'Weekly',
  '0 0 1 * *':     'Monthly',
};
function humanCron(cron: string): string {
  return CRON_LABEL[cron] ?? cron;
}

function timeAgo(ts: string | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Failure-pattern detection — derived from existing fields, no new
// backend data needed. Worst-first match wins.
type FailurePattern =
  | { severity: 'critical'; label: string; reason: string }
  | { severity: 'high';     label: string; reason: string }
  | { severity: 'medium';   label: string; reason: string }
  | null;

function failurePatternFor(f: FeedOverview): FailurePattern {
  if (f.paused_reason === 'auto:consecutive_failures') {
    return {
      severity: 'critical',
      label:    'Auto-paused',
      reason:   `${f.consecutive_failures ?? 0} consecutive failures`,
    };
  }
  if (f.paused_reason === 'manual') {
    return {
      severity: 'medium',
      label:    'Paused',
      reason:   'Manually disabled',
    };
  }
  if ((f.consecutive_failures ?? 0) >= 3) {
    return {
      severity: 'high',
      label:    'Failing',
      reason:   `${f.consecutive_failures} consecutive failures`,
    };
  }
  if (f.total_pulls > 10 && f.total_ingested === 0) {
    return {
      severity: 'high',
      label:    'No ingestion',
      reason:   '10+ pulls, 0 records ingested',
    };
  }
  const total = f.successes + f.errors;
  if (total >= 10 && f.errors / total > 0.30) {
    return {
      severity: 'high',
      label:    'High error rate',
      reason:   `${Math.round((f.errors / total) * 100)}% errors`,
    };
  }
  return null;
}

// Multi-series compact area chart for feed cards. Hand-rolled SVG
// (no Recharts) so 40+ cards stay cheap. Three series share the
// same y-scale so they're comparable. Same visual identity as the
// agents-v3 CardHealthChart pattern. Errors series only renders
// when the feed actually has errors in the 24h window.
function FeedCardSparkline({
  pulls, ingested, errors, runsColor, width = 120, height = 40,
}: {
  pulls:     number[];
  ingested?: number[];
  errors?:   number[];
  runsColor: string;
  width?:    number;
  height?:   number;
}) {
  if (!pulls || pulls.length === 0) return null;
  const N = pulls.length;
  const peak = Math.max(
    ...pulls,
    ...(ingested ?? []),
    ...(errors   ?? []),
    1,
  );
  const stepX = N > 1 ? width / (N - 1) : width;

  function paths(series: number[]) {
    const points = series.map((v, i) => {
      const x = i * stepX;
      const y = height - (v / peak) * (height - 2) - 1;
      return { x, y };
    });
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L ${(N - 1) * stepX} ${height} L 0 ${height} Z`;
    return { line, area };
  }

  const seed = Math.random().toString(36).slice(2, 9);
  const gradPulls    = `feed-pulls-${seed}`;
  const gradIngested = `feed-ing-${seed}`;
  const gradErrors   = `feed-err-${seed}`;

  const pullsP    = paths(pulls);
  const ingestedP = ingested && ingested.some(v => v > 0) ? paths(ingested) : null;
  const errorsP   = errors   && errors.some(v => v > 0)   ? paths(errors)   : null;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={gradPulls} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%"  stopColor={runsColor} stopOpacity={0.40} />
          <stop offset="95%" stopColor={runsColor} stopOpacity={0} />
        </linearGradient>
        <linearGradient id={gradIngested} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%"  stopColor="#22D3EE" stopOpacity={0.30} />
          <stop offset="95%" stopColor="#22D3EE" stopOpacity={0} />
        </linearGradient>
        <linearGradient id={gradErrors} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%"  stopColor="var(--sev-high)" stopOpacity={0.40} />
          <stop offset="95%" stopColor="var(--sev-high)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={pullsP.area} fill={`url(#${gradPulls})`} />
      <path d={pullsP.line} stroke={runsColor} strokeWidth={1.3} fill="none" strokeLinejoin="round" />
      {ingestedP && (
        <>
          <path d={ingestedP.area} fill={`url(#${gradIngested})`} />
          <path d={ingestedP.line} stroke="#22D3EE" strokeWidth={1.1} fill="none" strokeLinejoin="round" opacity={0.85} />
        </>
      )}
      {errorsP && (
        <>
          <path d={errorsP.area} fill={`url(#${gradErrors})`} />
          <path d={errorsP.line} stroke="var(--sev-high)" strokeWidth={1.1} fill="none" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function isDecommissionCandidate(f: FeedOverview): boolean {
  if (!f.last_completed) return false;
  const ageMs = Date.now() - new Date(f.last_completed).getTime();
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  return ageMs > fourteenDays;
}

function PreviewBanner() {
  return (
    <Card variant="elevated" className="p-4">
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 w-8 h-8 rounded-md grid place-items-center"
          style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}
        >
          v3
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--amber)' }}>
            Feeds · v3 preview
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Triage-focused card grid with failure-pattern detection. Same data
            as <Link to="/feeds" className="underline" style={{ color: 'var(--amber)' }}>V2</Link>;
            iterating from screenshots — toggle back any time, your choice persists.
          </p>
        </div>
      </div>
    </Card>
  );
}

function FeedCardV3({
  feed, isSelected, onSelect,
}: {
  feed:       FeedOverview;
  isSelected: boolean;
  onSelect:   () => void;
}) {
  const pattern  = failurePatternFor(feed);
  const decom    = isDecommissionCandidate(feed);
  const total    = feed.successes + feed.errors;
  const errorPct = total > 0 ? Math.round((feed.errors / total) * 100) : 0;

  const variant: 'elevated' | 'critical' =
    pattern?.severity === 'critical' || decom ? 'critical' : 'elevated';

  return (
    <Card
      variant={variant}
      className="p-4 flex flex-col gap-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="flex-shrink-0 w-8 h-8 rounded-md grid place-items-center"
          style={{
            background: 'var(--bg-input)',
            color:      pattern ? 'var(--sev-high)' : 'var(--blue)',
          }}
        >
          {pattern?.severity === 'critical' || feed.paused_reason
            ? <Pause size={14} />
            : <Activity size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[13px] font-bold uppercase tracking-wide truncate" style={{ color: 'var(--text-primary)' }}>
              {feed.display_name || feed.feed_name}
            </span>
            {pattern && (
              <Badge severity={pattern.severity}>
                <AlertTriangle size={10} className="inline mr-1" />
                {pattern.label}
              </Badge>
            )}
            {!pattern && decom && (
              <Badge severity="high">
                <AlertTriangle size={10} className="inline mr-1" />
                Stale?
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
            <Clock size={10} />
            {humanCron(feed.schedule_cron)} · last {timeAgo(feed.last_completed)}
          </div>
        </div>
        <ChevronDown
          size={14}
          style={{
            color:      'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        />
      </div>

      {/* Stats row + sparkline */}
      <div className="flex items-end justify-between gap-3">
        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono flex-1">
          <div>
            <div style={{ color: 'var(--text-muted)' }}>PULLS</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>
              {feed.total_pulls.toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>INGESTED</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>
              {feed.total_ingested.toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>ERROR %</div>
            <div
              className="text-base"
              style={{ color: errorPct > 20 ? 'var(--sev-high)' : 'var(--text-primary)' }}
            >
              {errorPct}%
            </div>
          </div>
        </div>
        {feed.pulls_per_hour && feed.pulls_per_hour.length > 0 && (
          <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
            <FeedCardSparkline
              pulls={feed.pulls_per_hour}
              ingested={feed.ingested_per_hour}
              errors={feed.errors_per_hour}
              runsColor={pattern ? 'var(--sev-high)' : 'var(--blue)'}
              width={120}
              height={36}
            />
            <div className="font-mono text-[8px] tracking-[0.12em] uppercase" style={{ color: 'var(--text-muted)' }}>
              24h · pulls · ingested
            </div>
          </div>
        )}
      </div>

      {pattern && (
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {pattern.reason}
        </div>
      )}
    </Card>
  );
}

function FeedDetailPanelV3({ feed }: { feed: FeedOverview }) {
  return (
    <Card variant="elevated" className="p-5 col-span-full">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left — config + status */}
        <div className="space-y-3">
          {feed.description && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
                What it does
              </div>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {feed.description}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 font-mono text-[10px]">
            <Row label="Cron"      value={feed.schedule_cron} />
            <Row label="Schedule"  value={humanCron(feed.schedule_cron)} />
            <Row label="Batch"     value={feed.batch_size?.toString() ?? '—'} />
            <Row label="Rate cap"  value={feed.rate_limit?.toString() ?? '—'} />
            <Row label="Retries"   value={feed.retry_count?.toString() ?? '—'} />
            <Row label="Threshold" value={feed.consecutive_failure_threshold?.toString() ?? '—'} />
          </div>
          {feed.last_error && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--sev-high)' }}>
                Last error
              </div>
              <div className="font-mono text-[11px] p-2 rounded" style={{
                background: 'var(--sev-critical-bg)',
                color:      'var(--text-primary)',
                border:     '1px solid var(--sev-critical-border)',
              }}>
                {feed.last_error}
              </div>
            </div>
          )}
        </div>

        {/* Right — totals + source */}
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Pulls"    value={feed.total_pulls.toLocaleString()} />
            <Stat label="Successes" value={feed.successes.toLocaleString()} tone="green" />
            <Stat label="Errors"   value={feed.errors.toLocaleString()}    tone={feed.errors > 0 ? 'sev-high' : undefined} />
            <Stat label="Ingested" value={feed.total_ingested.toLocaleString()} />
            <Stat label="Rejected" value={feed.total_rejected.toLocaleString()} />
            <Stat label="Conseq. Fail" value={(feed.consecutive_failures ?? 0).toString()} tone={(feed.consecutive_failures ?? 0) > 0 ? 'sev-high' : undefined} />
          </div>
          {feed.source_url && (
            <div>
              <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
                Source
              </div>
              <div className="font-mono text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                {feed.source_url}
              </div>
            </div>
          )}
          <div>
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Recent pulls · last 20
            </div>
            <FeedHistorySection feedName={feed.feed_name} />
          </div>
        </div>
      </div>
    </Card>
  );
}

// Recent-pulls history list rendered inside the detail panel. Lazy
// fetch — `enabled: !!feedName` in useFeedHistory means this only
// fires when a card actually expands. Mirrors v2's recent-runs pane
// but with a denser layout (one line per pull, error inline below).
function FeedHistorySection({ feedName }: { feedName: string }) {
  const { data: history, isLoading } = useFeedHistory(feedName, 20);

  if (isLoading) {
    return (
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Loading history…
      </div>
    );
  }
  if (!history || history.length === 0) {
    return (
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        No pull history yet
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {history.slice(0, 20).map(record => (
        <PullRow key={record.id} record={record} />
      ))}
    </div>
  );
}

function PullRow({ record }: { record: FeedPullRecord }) {
  const isSuccess = record.status === 'success';
  const isPartial = record.status === 'partial';
  const tone =
    isSuccess ? 'var(--green)' :
    isPartial ? 'var(--sev-medium)' :
                'var(--sev-high)';
  const when = new Date(record.started_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  const dur = record.duration_ms != null
    ? `${(record.duration_ms / 1000).toFixed(1)}s`
    : '—';

  return (
    <div
      className="rounded px-2 py-1.5"
      style={{
        background: 'var(--bg-input)',
        border:     `1px solid ${isSuccess ? 'var(--border-base)' : 'var(--sev-critical-border)'}`,
      }}
    >
      <div className="flex items-center gap-2 font-mono text-[10px]">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: tone }}
        />
        <span style={{ color: 'var(--text-tertiary)' }} className="flex-1 truncate">
          {when}
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {record.records_ingested.toLocaleString()}
          {record.records_rejected > 0 && (
            <span style={{ color: 'var(--sev-medium)' }}>
              {' '}/ {record.records_rejected.toLocaleString()} rej
            </span>
          )}
        </span>
        <span style={{ color: 'var(--text-muted)', minWidth: 36, textAlign: 'right' }}>
          {dur}
        </span>
      </div>
      {!isSuccess && record.error_message && (
        <div
          className="font-mono text-[10px] mt-1 line-clamp-2"
          style={{ color: 'var(--sev-high)' }}
          title={record.error_message}
        >
          {record.error_message}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-muted)' }}>{label.toUpperCase()}</div>
      <div className="text-xs" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'sev-high' }) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'sev-high' ? 'var(--sev-high)' : 'var(--text-primary)';
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-lg font-mono" style={{ color }}>{value}</div>
    </div>
  );
}

export function FeedsV3() {
  const { data: feeds = [], isLoading } = useFeeds();
  const { data: stats } = useFeedStats();
  const [selected, setSelected] = useState<string | null>(null);

  const failureCount = useMemo(
    () => feeds.filter(f => failurePatternFor(f) !== null).length,
    [feeds]
  );

  if (isLoading) return <CardGridLoader count={6} />;

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title="Feed Intake"
        subtitle="v3 preview · triage-focused with failure-pattern detection"
        actions={
          <div className="flex items-center gap-3">
            <VersionToggle surface="feeds" ariaLabel="Feeds page version" />
            <LiveIndicator />
          </div>
        }
      />

      <PreviewBanner />

      <StatGrid cols={4}>
        <StatCard label="Active"       value={stats?.active   ?? 0} accentColor="var(--green)" />
        <StatCard label="Disabled"     value={stats?.disabled ?? 0} />
        <StatCard label="Records (24h)" value={(stats?.total_ingested ?? 0).toLocaleString()} />
        <StatCard
          label="Failure Patterns"
          value={failureCount}
          accentColor={failureCount > 0 ? 'var(--sev-high)' : undefined}
        />
      </StatGrid>

      {feeds.length === 0 ? (
        <EmptyState
          icon={<Rss />}
          title="No feeds configured"
          subtitle="Threat-intel feed sources haven't been wired yet."
          variant="error"
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {feeds.map(feed => (
            <Fragment key={feed.feed_name}>
              <FeedCardV3
                feed={feed}
                isSelected={selected === feed.feed_name}
                onSelect={() =>
                  setSelected(prev => prev === feed.feed_name ? null : feed.feed_name)
                }
              />
              {selected === feed.feed_name && <FeedDetailPanelV3 feed={feed} />}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

