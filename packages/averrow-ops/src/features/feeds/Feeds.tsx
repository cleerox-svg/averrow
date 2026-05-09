import { useState, useMemo } from 'react';
import { useFeeds, useFeedHistory } from '@/hooks/useFeeds';
import { useAdminAction } from '@/hooks/useAdminAction';
import type { FeedOverview, FeedPullRecord } from '@/hooks/useFeeds';
import { Skeleton } from '@/components/ui/Skeleton';
import { ThreatAreaChart } from '@/components/ui/ThreatAreaChart';
import { DataRow, SeverityDot } from '@/components/ui/DataRow';
import { cn } from '@/lib/cn';
import { RotateCw, Loader2, Check, X, Zap, Play } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useQueryClient } from '@tanstack/react-query';
import {
  Card,
  StatCard,
  StatGrid,
  PageHeader,
  Button,
} from '@/design-system/components';
import { VersionToggle } from '@/components/ui/VersionToggle';

/* ─── Helpers ─── */

// Single source of truth for "this feed needs attention" — three
// surfaces (NEEDS ATTENTION tile, AttentionBanner, FeedHealthStrip
// warning dots) all use this so they always agree on the count.
//
// A feed only counts as needing attention once it's actually been
// polled — a freshly enabled feed with 0 pulls is still warming up,
// not broken.
function needsAttention(f: FeedOverview): boolean {
  return Boolean(f.enabled) && f.total_pulls > 10 && f.total_ingested === 0;
}

function humanizeCron(cron: string): string {
  const map: Record<string, string> = {
    '*/5 * * * *':   'Every 5 minutes',
    '*/15 * * * *':  'Every 15 minutes',
    '*/30 * * * *':  'Every 30 minutes',
    '0 * * * *':     'Every hour',
    '0 */2 * * *':   'Every 2 hours',
    '0 */4 * * *':   'Every 4 hours',
    '0 */6 * * *':   'Every 6 hours',
    '0 */12 * * *':  'Every 12 hours',
    '0 0 * * *':     'Daily at midnight',
    '0 3 * * *':     'Daily at 3 AM',
    '0 4 * * *':     'Daily at 4 AM',
    '0 6 * * *':     'Daily at 6 AM',
    '0 0 * * 0':     'Weekly on Sunday',
    '0 0 * * 1':     'Weekly on Monday',
    '0 0 1 * *':     'Monthly on the 1st',
  };
  // Fall back to a generic label rather than leaking cron syntax into
  // user-visible copy (audit C9).
  return map[cron] ?? 'Custom schedule';
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function detectFeedIssue(feed: FeedOverview): string | null {
  if (!feed.enabled) return null;
  if (feed.total_pulls > 10 && feed.total_ingested === 0) {
    if (feed.feed_name === 'otx_alienvault')
      return 'HTTP 403 Forbidden — API key invalid or expired';
    if (feed.feed_name === 'cloudflare_scanner')
      return 'Rate limited — 500 scan/month cap reached';
    if (feed.feed_name === 'feodo')
      return 'No matching threats ingested — check filter config';
    if (feed.feed_name === 'cloudflare_email')
      return 'No email threats detected in current window';
    // 0 ingested but rejected>0 = dedup working as designed.
    // Most public feeds publish IOCs already in the threats table
    // (217K+ rows) — duplicate suppression is the success case,
    // not a problem to flag. Only fire the generic warning when
    // BOTH ingested and rejected are zero (truly silent feed —
    // parser/scraper likely broken).
    if (feed.total_rejected > 0) return null;
    return '0 records ingested despite active pulls — investigate';
  }
  return null;
}

function successRate(feed: FeedOverview): number {
  if (feed.total_pulls === 0) return 0;
  return Math.round((feed.successes / feed.total_pulls) * 100);
}

function successBarGradient(rate: number): string {
  if (rate >= 90) return 'linear-gradient(90deg, var(--green-dim), var(--green))';
  if (rate >= 60) return 'linear-gradient(90deg, var(--amber-dim), var(--amber))';
  return 'linear-gradient(90deg, var(--red-dim), var(--red))';
}

type FeedCategory = 'healthy' | 'attention' | 'disabled';

function categorizeFeed(feed: FeedOverview): FeedCategory {
  if (!feed.enabled) return 'disabled';
  if (feed.total_ingested === 0) return 'attention';
  return 'healthy';
}

/** True when a feed was auto-paused by the feedRunner after N consecutive failures. */
function isAutoPaused(feed: FeedOverview): boolean {
  return feed.enabled === 0 && feed.paused_reason === 'auto:consecutive_failures';
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/* ─── Trigger Buttons ─── */

function TriggerAllButton() {
  const queryClient = useQueryClient();
  const action = useAdminAction('/api/feeds/trigger-all', () => {
    setTimeout(() => queryClient.invalidateQueries({ queryKey: ['feeds-overview'] }), 3000);
  });

  if (action.state === 'idle') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={action.confirm}
        icon={<RotateCw className="w-3.5 h-3.5" />}
      >
        <span className="hidden sm:inline">Trigger All</span>
      </Button>
    );
  }
  if (action.state === 'confirming') {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-amber-400">Trigger all feeds?</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={action.execute}
          icon={<Check className="w-3 h-3" />}
          style={{ color: '#4ade80' }}
        >
          Confirm
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={action.cancel}
          icon={<X className="w-3 h-3" />}
        >
          Cancel
        </Button>
      </div>
    );
  }
  if (action.state === 'loading') {
    return (
      <span className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: 'var(--amber)' }}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Triggering...
      </span>
    );
  }
  if (action.state === 'success') {
    return (
      <span className="flex items-center gap-1.5 font-mono text-[10px] text-green-400">
        <Check className="w-3.5 h-3.5" /> Feeds triggered
      </span>
    );
  }
  return (
    <span className="font-mono text-[10px] text-red-400">{action.error || 'Failed'}</span>
  );
}

function RetryButton({ feedName }: { feedName: string }) {
  const queryClient = useQueryClient();
  const action = useAdminAction(`/api/feeds/${feedName}/trigger`, () => {
    setTimeout(() => queryClient.invalidateQueries({ queryKey: ['feeds-overview'] }), 3000);
  });

  if (action.state === 'idle') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={(e) => { e.stopPropagation(); action.confirm(); }}
        icon={<RotateCw className="w-3 h-3" />}
        style={{ color: 'var(--amber)' }}
      >
        Retry
      </Button>
    );
  }
  if (action.state === 'confirming') {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={action.execute}
          icon={<Check className="w-3 h-3" />}
          style={{ color: '#4ade80' }}
        >
          {''}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={action.cancel}
          icon={<X className="w-3 h-3" />}
        >
          {''}
        </Button>
      </div>
    );
  }
  if (action.state === 'loading') {
    return (
      <span className="flex items-center gap-1 font-mono text-[9px]" style={{ color: 'var(--amber)' }} onClick={(e) => e.stopPropagation()}>
        <Loader2 className="w-3 h-3 animate-spin" />
      </span>
    );
  }
  if (action.state === 'success') {
    return (
      <span className="flex items-center gap-1 font-mono text-[9px] text-green-400">
        <Check className="w-3 h-3" />
      </span>
    );
  }
  return (
    <span className="font-mono text-[9px] text-red-400">
      <X className="w-3 h-3 inline" />
    </span>
  );
}

function UnpauseButton({ feedName }: { feedName: string }) {
  const queryClient = useQueryClient();
  const action = useAdminAction(`/api/feeds/${feedName}/unpause`, () => {
    setTimeout(() => queryClient.invalidateQueries({ queryKey: ['feeds-overview'] }), 500);
  });

  if (action.state === 'idle') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={(e) => { e.stopPropagation(); action.confirm(); }}
        icon={<Play className="w-3 h-3" />}
        style={{ color: 'var(--amber)' }}
      >
        Unpause
      </Button>
    );
  }
  if (action.state === 'confirming') {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <span className="font-mono text-[10px] text-amber-400">Unpause?</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={action.execute}
          icon={<Check className="w-3 h-3" />}
          style={{ color: '#4ade80' }}
        >
          {''}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={action.cancel}
          icon={<X className="w-3 h-3" />}
        >
          {''}
        </Button>
      </div>
    );
  }
  if (action.state === 'loading') {
    return (
      <span
        className="flex items-center gap-1 font-mono text-[9px]"
        style={{ color: 'var(--amber)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <Loader2 className="w-3 h-3 animate-spin" /> Unpausing
      </span>
    );
  }
  if (action.state === 'success') {
    return (
      <span className="flex items-center gap-1 font-mono text-[9px] text-green-400">
        <Check className="w-3 h-3" /> Unpaused
      </span>
    );
  }
  return (
    <span className="font-mono text-[9px] text-red-400" onClick={(e) => e.stopPropagation()}>
      {action.error || 'Failed'}
    </span>
  );
}

/* ─── Components ─── */

function HeaderStats({ feeds }: { feeds: FeedOverview[] }) {
  const active = feeds.filter(f => f.enabled).length;
  const disabled = feeds.filter(f => !f.enabled).length;
  const totalIngested = feeds.reduce((s, f) => s + f.total_ingested, 0);
  const attentionCount = feeds.filter(needsAttention).length;

  return (
    <StatGrid cols={4}>
      <StatCard label="Active Feeds"    value={active}        accentColor="var(--green)" />
      <StatCard label="Total Ingested"  value={totalIngested} accentColor="var(--amber)" />
      <StatCard label="Needs Attention" value={attentionCount} accentColor={attentionCount > 0 ? 'var(--sev-medium)' : undefined} />
      <StatCard label="Disabled"        value={disabled} />
    </StatGrid>
  );
}

function AttentionBanner({ feeds }: { feeds: FeedOverview[] }) {
  const attentionFeeds = feeds.filter(needsAttention);
  if (attentionFeeds.length === 0) return null;

  const names = attentionFeeds.map(f => {
    const issue = detectFeedIssue(f);
    return issue ? `${f.display_name} (${issue.split('—')[0].trim().toLowerCase()})` : f.display_name;
  });

  return (
    <Card variant="active" style={{ padding: '16px' }}>
      <div className="flex items-start gap-2">
        <span className="text-amber-400 text-sm mt-0.5">&#9888;</span>
        <div>
          <span className="text-[13px] font-semibold font-display" style={{ color: 'var(--text-primary)' }}>
            {attentionFeeds.length} feed{attentionFeeds.length > 1 ? 's' : ''} need attention
          </span>
          <span className="text-[12px] text-white/50 ml-1">
            — {names.join(', ')} {attentionFeeds.length > 1 ? 'are' : 'is'} enabled but ingesting 0 records.
          </span>
        </div>
      </div>
    </Card>
  );
}

function FeedHealthStrip({ feeds }: { feeds: FeedOverview[] }) {
  // "warning" matches the NEEDS ATTENTION tile + banner exactly (tried
  // and failed). Feeds enabled-but-not-yet-pulled fall into "warmup"
  // and render as neutral dots — they shouldn't trip the warning count.
  const healthy = feeds.filter(f => f.enabled && f.total_ingested > 0);
  const warning = feeds.filter(needsAttention);
  const warmup = feeds.filter(f => f.enabled && f.total_pulls <= 10 && f.total_ingested === 0);
  const disabled = feeds.filter(f => !f.enabled);

  return (
    <Card style={{ padding: '16px' }}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)]">Feed Health</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {healthy.map(f => (
            <div key={f.feed_name} className="w-2.5 h-2.5 rounded-full bg-green-400" title={f.display_name} />
          ))}
          {warning.map(f => (
            <div key={f.feed_name} className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" title={`${f.display_name} (needs attention)`} />
          ))}
          {warmup.map(f => (
            <div key={f.feed_name} className="w-2.5 h-2.5 rounded-full bg-blue-400/40" title={`${f.display_name} (warming up)`} />
          ))}
          {disabled.map(f => (
            <div key={f.feed_name} className="w-2.5 h-2.5 rounded-full border border-white/20 bg-transparent" title={f.display_name} />
          ))}
        </div>
        <div className="flex items-center gap-3 ml-auto text-[10px] font-mono text-white/40">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> {healthy.length} healthy</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> {warning.length} warning</span>
          {warmup.length > 0 && (
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400/40 inline-block" /> {warmup.length} warming up</span>
          )}
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full border border-white/20 inline-block" /> {disabled.length} disabled</span>
        </div>
      </div>
    </Card>
  );
}

function FeedCard({
  feed,
  category,
  isExpanded,
  onToggle,
}: {
  feed: FeedOverview;
  category: FeedCategory;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const rate = successRate(feed);
  const issue = detectFeedIssue(feed);
  const autoPaused = isAutoPaused(feed);

  // Auto-paused feeds surface as critical-severity cards so they're visually
  // distinguishable from plain manually-disabled ones.
  const cardVariant: 'base' | 'active' | 'critical' =
    autoPaused ? 'critical' :
    category === 'attention' ? 'active' : 'base';
  const cardClass = cn(
    'cursor-pointer transition-all',
    category === 'disabled' && !autoPaused && 'opacity-60',
  );

  const badgeClass = cn(
    'text-[9px] font-mono font-semibold uppercase tracking-wider px-2 py-0.5 rounded border',
    category === 'healthy' && 'text-green-400 border-green-500/30 bg-green-900/30',
    category === 'attention' && 'text-amber-400 border-amber-500/30 bg-amber-900/30',
    autoPaused && 'text-red-400 border-red-500/40 bg-red-900/30',
    category === 'disabled' && !autoPaused && 'text-white/40 border-white/10 bg-white/5',
  );

  const badgeLabel =
    category === 'healthy'   ? 'ACTIVE'
  : category === 'attention' ? 'WARNING'
  : autoPaused               ? `AUTO-PAUSED${feed.consecutive_failures ? ` · ${feed.consecutive_failures}✗` : ''}`
  :                            'PAUSED';

  const dotClass = cn(
    'w-2.5 h-2.5 rounded-full flex-shrink-0',
    category === 'healthy' && 'bg-green-400',
    category === 'attention' && 'bg-amber-400 animate-pulse',
    autoPaused && 'bg-red-500 animate-pulse',
    category === 'disabled' && !autoPaused && 'border border-white/20',
  );

  return (
    <div>
      <Card variant={cardVariant} className={cardClass} style={{ padding: '16px' }} onClick={onToggle}>
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className={dotClass} />
            <span className="text-[14px] font-semibold font-display truncate" style={{ color: 'var(--text-primary)' }}>
              {feed.display_name}
            </span>
          </div>
          <span className={badgeClass}>{badgeLabel}</span>
        </div>

        {/* Subtitle */}
        <div className="text-[11px] text-white/40 font-mono ml-[18px] mb-3">
          {feed.description ? `${feed.description} · ` : ''}
          {category === 'disabled' ? humanizeCron(feed.schedule_cron) : humanizeCron(feed.schedule_cron)}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <div className={cn('text-[16px] font-bold font-mono', feed.total_ingested > 0 ? 'text-[var(--text-primary)]' : 'text-white/30')}>
              {formatNumber(feed.total_ingested)}
            </div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-white/40">Threats</div>
          </div>
          <div>
            <div className="text-[16px] font-bold font-mono" style={{ color: 'var(--text-primary)' }}>
              {formatNumber(feed.total_pulls)}
            </div>
            <div className="text-[9px] font-mono uppercase tracking-wider text-white/40">Pulls</div>
          </div>
          <div>
            {category === 'disabled' ? (
              <>
                <div className="text-[16px] font-bold font-mono text-white/40">&mdash;</div>
                <div className="text-[9px] font-mono uppercase tracking-wider text-white/40">Last Run</div>
              </>
            ) : (
              <>
                <div className="text-[16px] font-bold font-mono" style={{ color: 'var(--text-primary)' }}>
                  {formatNumber(feed.successes)}
                </div>
                <div className="text-[9px] font-mono uppercase tracking-wider text-white/40">Successes</div>
              </>
            )}
          </div>
        </div>

        {/* Issue banner for attention feeds */}
        {issue && (
          <div className="text-[11px] text-amber-400 font-mono mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <span>&#9888;</span> {issue}
            </div>
            {category === 'attention' && (
              <RetryButton feedName={feed.feed_name} />
            )}
          </div>
        )}

        {/* Footer */}
        {category !== 'disabled' && (
          <div className="space-y-2">
            <div className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
              Last run: {timeAgo(feed.last_run)}
            </div>
            {/* Success rate bar — CSS vars, green/amber/red by rate */}
            <div className="flex items-center gap-2">
              <div
                style={{
                  flex: 1,
                  height: 3,
                  borderRadius: 99,
                  overflow: 'hidden',
                  background: 'var(--border-base)',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(rate, 100)}%`,
                    borderRadius: 99,
                    background: successBarGradient(rate),
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
                {rate}%
              </span>
            </div>
          </div>
        )}

        {category === 'disabled' && !autoPaused && (
          <div className="text-[10px] text-white/40 font-mono">
            Paused{feed.paused_reason === 'manual' ? ' · manual' : ''}
          </div>
        )}

        {autoPaused && (
          <div className="space-y-2">
            <div
              className="text-[11px] font-mono flex items-start gap-1.5"
              style={{ color: 'var(--sev-critical)' }}
            >
              <span>&#9888;</span>
              <span>
                Paused by system after {feed.consecutive_failures ?? 0} consecutive failures.
                {feed.last_error ? ` Last error: ${feed.last_error.slice(0, 120)}${feed.last_error.length > 120 ? '…' : ''}` : ''}
              </span>
            </div>
            <div className="flex items-center justify-end">
              <UnpauseButton feedName={feed.feed_name} />
            </div>
          </div>
        )}
      </Card>

      {/* Expanded detail panel */}
      {isExpanded && (
        <FeedDetailPanel feed={feed} category={category} />
      )}
    </div>
  );
}

function FeedDetailPanel({ feed, category }: { feed: FeedOverview; category: FeedCategory }) {
  const { data: history, isLoading } = useFeedHistory(feed.feed_name, 20);

  // Transform recent pull records into chart data (oldest → newest for the area chart)
  const chartData = useMemo(() => {
    if (!history) return [];
    return [...history].reverse().slice(-20).map((h: FeedPullRecord) => ({
      label: new Date(h.started_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit',
      }),
      value: h.records_ingested,
    }));
  }, [history]);

  const chartColor =
    category === 'attention' ? 'var(--sev-high)' :
    category === 'disabled'  ? 'var(--text-muted)' :
                               'var(--sev-info)';

  const configRows: Array<{ label: string; value: string; mono?: boolean; truncate?: boolean }> = [
    { label: 'Feed Name',    value: feed.feed_name, mono: true },
    { label: 'Display Name', value: feed.display_name ?? '—' },
    { label: 'Description',  value: feed.description ?? '—' },
    { label: 'Source URL',   value: feed.source_url ?? '—', mono: true, truncate: true },
    { label: 'Schedule',     value: humanizeCron(feed.schedule_cron), mono: true },
    { label: 'Batch Size',   value: feed.batch_size != null ? feed.batch_size.toLocaleString() : '—' },
    { label: 'Rate Limit',   value: feed.rate_limit != null ? `${feed.rate_limit}/min` : '—' },
    { label: 'Status',       value: feed.enabled ? 'Enabled' : 'Disabled' },
  ];

  const retryConfig = feed.retry_count != null
    ? `${feed.retry_count} retries · ${feed.retry_delay_seconds ?? 0}s delay`
    : null;

  return (
    <Card
      className="mt-2"
      style={{
        padding: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 16,
      }}
    >
      {/* LEFT — Feed Configuration */}
      <div style={{
        padding: '16px',
        borderRight: '1px solid var(--border-base)',
      }}>
        <div style={{
          fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.20em',
          color: 'var(--amber)', textTransform: 'uppercase', marginBottom: 10,
          fontWeight: 800,
        }}>
          Feed Configuration
        </div>

        {configRows.map(({ label, value, mono, truncate }) => (
          <div key={label} style={{
            display: 'flex', alignItems: 'flex-start',
            gap: 8, padding: '5px 0',
            borderBottom: '1px solid var(--border-base)',
          }}>
            <div style={{
              fontSize: 9, fontFamily: 'var(--font-mono)',
              color: 'var(--text-muted)', letterSpacing: '0.10em',
              textTransform: 'uppercase', minWidth: 90, flexShrink: 0,
              paddingTop: 1,
            }}>
              {label}
            </div>
            {label === 'Source URL' && feed.source_url ? (
              <a
                href={feed.source_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                  textDecoration: 'none',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {value}
              </a>
            ) : (
              <div style={{
                fontSize: mono ? 10 : 12,
                fontFamily: mono ? 'var(--font-mono)' : 'inherit',
                color: 'var(--text-secondary)',
                overflow: truncate ? 'hidden' : 'visible',
                textOverflow: truncate ? 'ellipsis' : 'clip',
                whiteSpace: truncate ? 'nowrap' : 'normal',
                flex: 1, minWidth: 0,
              }}>
                {value}
              </div>
            )}
          </div>
        ))}

        {retryConfig && (
          <div style={{
            marginTop: 8, padding: '6px 10px', borderRadius: 8,
            background: 'var(--border-base)',
            border: '1px solid var(--border-base)',
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
          }}>
            Retry: {retryConfig}
          </div>
        )}

        {feed.filters && (
          <div style={{
            marginTop: 8, padding: '6px 10px', borderRadius: 8,
            background: 'var(--border-base)',
            border: '1px solid var(--border-base)',
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            Filters: {feed.filters}
          </div>
        )}
      </div>

      {/* RIGHT — Pull History + Recent Runs */}
      <div style={{ padding: '16px', minWidth: 0 }}>
        <div style={{
          fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.20em',
          color: 'var(--amber)', textTransform: 'uppercase', marginBottom: 10,
          fontWeight: 800,
        }}>
          Pull History
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <>
            {chartData.length > 1 ? (
              <ThreatAreaChart
                data={chartData}
                height={120}
                color={chartColor}
                label="Records Ingested"
                showXAxis={false}
                showGrid={false}
              />
            ) : (
              <div style={{
                height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-muted)', fontSize: 11,
                fontStyle: 'italic',
              }}>
                No pull history yet
              </div>
            )}

            {/* Recent run records */}
            <div style={{ marginTop: 12 }}>
              <div style={{
                fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.14em',
                color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6,
              }}>
                Recent Runs
              </div>

              {history && history.length > 0 ? (
                history.slice(0, 6).map((record: FeedPullRecord) => {
                  const isSuccess = record.status === 'success';
                  const dur = record.duration_ms != null
                    ? `${(record.duration_ms / 1000).toFixed(1)}s`
                    : '—';
                  const when = new Date(record.started_at).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  });

                  return (
                    <DataRow key={record.id} severity={isSuccess ? undefined : 'high'}>
                      <div
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '5px 8px', width: '100%',
                        }}
                        title={!isSuccess ? (record.error_message ?? undefined) : undefined}
                      >
                        <SeverityDot severity={isSuccess ? 'info' : 'high'} size={7} />
                        <span style={{
                          fontSize: 10, fontFamily: 'var(--font-mono)',
                          color: 'var(--text-muted)', flex: 1,
                        }}>
                          {when}
                        </span>
                        <span style={{
                          fontSize: 11, fontWeight: 700,
                          color: isSuccess ? 'var(--sev-info)' : 'var(--sev-high)',
                          fontFamily: 'var(--font-mono)',
                        }}>
                          {record.records_ingested.toLocaleString()}
                        </span>
                        <span style={{
                          fontSize: 9, color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)', minWidth: 32, textAlign: 'right',
                        }}>
                          {dur}
                        </span>
                      </div>
                    </DataRow>
                  );
                })
              ) : (
                <div style={{
                  fontSize: 11, fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)', fontStyle: 'italic',
                }}>
                  No recent runs
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function FeedSection({
  title,
  feeds,
  category,
  expandedFeed,
  setExpandedFeed,
  cardClass,
}: {
  title: string;
  feeds: FeedOverview[];
  category: FeedCategory;
  expandedFeed: string | null;
  setExpandedFeed: (name: string | null) => void;
  cardClass?: string;
}) {
  if (feeds.length === 0) return null;

  return (
    <div>
      <div className={cn('font-mono text-[10px] font-bold uppercase tracking-widest mb-3', cardClass)}>
        {title}
        <span className="text-white/50 ml-2 font-normal">{feeds.length}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {feeds.map(feed => (
          <FeedCard
            key={feed.feed_name}
            feed={feed}
            category={category}
            isExpanded={expandedFeed === feed.feed_name}
            onToggle={() =>
              setExpandedFeed(expandedFeed === feed.feed_name ? null : feed.feed_name)
            }
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Page ─── */

export function Feeds() {
  const { data: feeds, isLoading } = useFeeds();
  const [expandedFeed, setExpandedFeed] = useState<string | null>(null);

  const grouped = useMemo(() => {
    if (!feeds) return { healthy: [], attention: [], disabled: [] };
    const healthy: FeedOverview[] = [];
    const attention: FeedOverview[] = [];
    const disabled: FeedOverview[] = [];
    for (const f of feeds) {
      const cat = categorizeFeed(f);
      if (cat === 'healthy') healthy.push(f);
      else if (cat === 'attention') attention.push(f);
      else disabled.push(f);
    }
    return { healthy, attention, disabled };
  }, [feeds]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold font-display" style={{ color: 'var(--text-primary)' }}>Feeds</h1>
          <p className="text-sm text-[var(--text-muted)] font-mono mt-1">Threat intelligence feed sources</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-12 rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const allFeeds = feeds ?? [];

  return (
    <div className="space-y-5">
      {/* Page header */}
      <PageHeader
        title="Threat Feeds"
        subtitle={`${allFeeds.length} feed configurations · Threat intelligence ingestion`}
        actions={
          <div className="flex items-center gap-3">
            <VersionToggle surface="feeds" ariaLabel="Feeds page version" />
            <TriggerAllButton />
          </div>
        }
      />

      {/* 1. Header stats */}
      <HeaderStats feeds={allFeeds} />

      {/* 2. Attention banner */}
      <AttentionBanner feeds={allFeeds} />

      {/* 3. Feed health strip */}
      <FeedHealthStrip feeds={allFeeds} />

      {/* 4. Feed sections */}
      {allFeeds.length === 0 ? (
        <EmptyState
          icon={<Zap />}
          title="No feeds configured"
          subtitle="Configure your first threat intelligence feed to start ingesting data"
          variant="scanning"
        />
      ) : (
      <div className="space-y-6">
        <FeedSection
          title="Healthy Feeds"
          feeds={grouped.healthy}
          category="healthy"
          expandedFeed={expandedFeed}
          setExpandedFeed={setExpandedFeed}
          cardClass="text-green-400"
        />
        <FeedSection
          title="Needs Attention"
          feeds={grouped.attention}
          category="attention"
          expandedFeed={expandedFeed}
          setExpandedFeed={setExpandedFeed}
          cardClass="text-amber-400"
        />
        <FeedSection
          title="Disabled"
          feeds={grouped.disabled}
          category="disabled"
          expandedFeed={expandedFeed}
          setExpandedFeed={setExpandedFeed}
          cardClass="text-white/40"
        />
      </div>
      )}
    </div>
  );
}
