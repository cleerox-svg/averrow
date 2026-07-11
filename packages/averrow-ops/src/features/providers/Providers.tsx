import { Fragment, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Card,
  StatCard,
  StatGrid,
  PageHeader,
  FilterBar,
  EmptyState,
  Skeleton,
  Badge,
} from '@/design-system/components';
import { TrendSparkline } from '@/components/ui/TrendSparkline';
import { Globe, Mail, ExternalLink, Zap } from 'lucide-react';
import {
  useProviderIntelligence,
  useProviders,
  useClusters,
  useProviderDetail,
  useProviderThreats,
  useProviderTimeline,
  useProviderClusters,
} from '@/hooks/useProviders';
import type { Provider, Cluster } from '@/hooks/useProviders';
import { useCardStyle } from '@/hooks/useCardStyle';

// ─── Helpers ──────────────────────────────────────────────────

function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

type ProviderStatus = 'accelerating' | 'pivot' | 'active' | 'quiet';

function getProviderStatus(p: Provider): ProviderStatus {
  const t7 = p.trend_7d ?? 0;
  const t30 = p.trend_30d ?? 0;
  if (t7 > 0 && t30 > 0 && t7 > t30 / 4) return 'accelerating';
  if (t7 === 0 && t30 > 50) return 'pivot';
  if (p.active_threat_count > 0) return 'active';
  return 'quiet';
}

function hasNexusLink(provider: Provider, clusters: Cluster[]): boolean {
  if (!provider.asn) return false;
  return clusters.some(c => {
    try {
      const asns = JSON.parse(c.asns) as string[];
      return asns.includes(provider.asn as string);
    } catch { return false; }
  });
}

function getClusterStatus(c: Cluster): ProviderStatus {
  if (c.status === 'dormant') return 'quiet';
  // Parse ASN trends from cluster data if available
  return c.status === 'active' ? 'active' : 'quiet';
}

// ─── Status Badge Component ──────────────────────────────────

function StatusBadge({ status }: { status: ProviderStatus }) {
  // Bundle C R8 migration: use the Badge.context tags (NEXUS-style
  // trend signals) instead of overloading `status` with custom labels.
  // Notable semantic fix: PIVOT was rendering with status="running"
  // (blue) — misleading because "went silent recently" should read
  // as critical/red, not as a healthy run state. Badge.context.pivot
  // is dedicated red.
  switch (status) {
    case 'accelerating':
      return <Badge context="accelerating" />;
    case 'pivot':
      return <Badge context="pivot" />;
    case 'active':
      return <Badge status="active" label="ACTIVE" />;
    case 'quiet':
      return <Badge context="quiet" />;
  }
}

// ─── Cluster Sidebar ─────────────────────────────────────────

function ClusterPanel({
  clusters,
  isLoading,
  selectedClusterId,
  onSelect,
}: {
  clusters: Cluster[];
  isLoading: boolean;
  selectedClusterId: string | null;
  onSelect: (id: string | null) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[9px] uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
        Cluster Intelligence
      </div>
      {selectedClusterId && (
        <button
          onClick={() => onSelect(null)}
          className="w-full text-left font-mono text-[10px] px-2 py-1 mb-1"
          style={{ color: 'var(--amber)' }}
        >
          Clear filter
        </button>
      )}
      {clusters.length === 0 && (
        <EmptyState
          icon={<Globe />}
          title="No clusters detected"
          subtitle="Infrastructure clusters will appear as threat correlations are identified"
          variant="scanning"
          compact
        />
      )}
      {clusters.map(cluster => {
        const status = getClusterStatus(cluster);
        const isSelected = selectedClusterId === cluster.id;
        return (
          <Card
            key={cluster.id}
            variant={isSelected ? 'active' : 'base'}
            onClick={() => onSelect(isSelected ? null : cluster.id)}
            padding="10px"
            className="w-full text-left"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                {cluster.cluster_name || `Cluster ${cluster.id.slice(0, 8)}`}
              </div>
              <StatusBadge status={status} />
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                {cluster.threat_count.toLocaleString()} threats
              </span>
              {cluster.countries && (
                <span className="font-mono text-[10px] text-white/50">
                  {(() => {
                    try {
                      return (JSON.parse(cluster.countries) as string[]).map(countryFlag).join(' ');
                    } catch { return ''; }
                  })()}
                </span>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Provider Card (dispatcher: unified vs classic) ──────────

function ProviderCard(props: {
  provider: Provider;
  clusters: Cluster[];
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const style = useCardStyle();
  return style === 'classic'
    ? <ProviderCardClassic {...props} />
    : <ProviderCardUnified {...props} />;
}

// ─── Provider Card (UNIFIED — matches Brands architecture) ───

function ProviderCardUnified({
  provider,
  clusters,
  isSelected,
  onSelect,
}: {
  provider: Provider;
  clusters: Cluster[];
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const status = getProviderStatus(provider);
  const nexusLinked = hasNexusLink(provider, clusters);
  const t7 = provider.trend_7d ?? 0;
  const t30 = provider.trend_30d ?? 0;
  const activeCount = provider.active_threat_count ?? 0;
  const sparkData = provider.threat_history ?? [];

  // Agents/Feeds/Metrics shell: calm `elevated` Card by default,
  // `critical` only on real problem states; `active` on selection.
  // No severity stripe; values stay plain --text-primary, with color
  // reserved for problem signals (rising trends, status alerts).
  const isProblemState = status === 'accelerating' || status === 'pivot';
  const variant: 'elevated' | 'critical' | 'active' =
    isSelected ? 'active' : isProblemState ? 'critical' : 'elevated';

  return (
    <Card
      variant={variant}
      hover={!isSelected}
      onClick={() => onSelect(provider.id)}
      className="p-4 flex flex-col gap-3 cursor-pointer transition-all"
    >
      {/* Header: country flag + name (mono caps) + status badges */}
      <div className="flex items-center gap-3">
        <div
          className="flex-shrink-0 flex items-center justify-center"
          style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'var(--border-base)',
            border: '1px solid var(--border-base)',
            fontSize: 16, lineHeight: 1,
          }}
        >
          {countryFlag(provider.country) || <Globe size={14} style={{ color: 'var(--text-muted)' }} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-mono text-[13px] font-bold uppercase tracking-wide truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {provider.name}
            </span>
            {nexusLinked && <Badge context="nexus" size="xs" />}
            <StatusBadge status={status} />
          </div>
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            {provider.asn || 'No ASN'}{provider.country ? ` · ${provider.country}` : ''}
          </div>
        </div>
      </div>

      {/* Metrics + top-right sparkline (mirrors Agents shell) */}
      <div className="flex items-end justify-between gap-3">
        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono flex-1">
          <div>
            <div style={{ color: 'var(--text-muted)' }}>ACTIVE</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>
              {activeCount.toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>7D TREND</div>
            <div
              className="text-base"
              style={{ color: t7 > 0 ? 'var(--sev-high)' : 'var(--text-primary)' }}
            >
              {t7 > 0 ? `+${t7}` : t7}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>30D TREND</div>
            <div
              className="text-base"
              style={{ color: t30 > 0 ? 'var(--sev-high)' : 'var(--text-primary)' }}
            >
              {t30 > 0 ? `+${t30}` : t30}
            </div>
          </div>
        </div>
        {sparkData.length > 1 && (
          <div className="flex flex-col items-end gap-1">
            <div style={{ width: 120, height: 36 }}>
              <TrendSparkline
                data={sparkData}
                fill
                height={36}
                color={isProblemState ? 'var(--sev-high)' : 'var(--amber)'}
                animate={false}
              />
            </div>
            <div
              className="font-mono text-[8px] tracking-[0.12em] uppercase"
              style={{ color: 'var(--text-muted)' }}
            >
              14d shape
            </div>
          </div>
        )}
      </div>

      {/* Status footer (only on problem states) */}
      {status === 'accelerating' && (
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {'↑'} Accelerating {'—'} activity up &gt;50% vs prior week
        </div>
      )}
      {status === 'pivot' && (
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {'→'} Pivot detected {'—'} went silent recently
        </div>
      )}
    </Card>
  );
}

// ─── Provider Card (CLASSIC — preserved for rollback) ────────

function ProviderCardClassic({
  provider,
  clusters,
  isSelected,
  onSelect,
}: {
  provider: Provider;
  clusters: Cluster[];
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const status = getProviderStatus(provider);
  const nexusLinked = hasNexusLink(provider, clusters);
  const t7 = provider.trend_7d ?? 0;
  const t30 = provider.trend_30d ?? 0;
  const sparkData = provider.threat_history ?? [];

  return (
    <Card
      variant={isSelected ? 'active' : 'base'}
      onClick={() => onSelect(provider.id)}
      padding="16px"
      className="w-full text-left"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base">{countryFlag(provider.country)}</span>
          <div className="min-w-0">
            <div className="font-display text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {provider.name}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                {provider.asn || 'No ASN'} {provider.country ? `\u00B7 ${provider.country}` : ''}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {nexusLinked && (
            <Badge context="nexus" size="xs" />
          )}
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-3 py-2 border-t border-b border-white/[0.06] my-2">
        <div>
          <div className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {provider.active_threat_count.toLocaleString()}
          </div>
          <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Active</div>
        </div>
        <div>
          <div className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {t7.toLocaleString()}
          </div>
          <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>7d Trend</div>
        </div>
        <div>
          <div className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
            {t30.toLocaleString()}
          </div>
          <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>30d Trend</div>
        </div>
      </div>

      {/* Sparkline bar */}
      <div className="mt-2">
        {sparkData.length >= 2 ? (
          <div style={{ position: 'relative' }}>
            <TrendSparkline
              data={sparkData}
              fill
              height={32}
              color={
                (provider.reputation_score ?? 50) < 30 ? 'var(--sev-critical)' :
                (provider.reputation_score ?? 50) < 60 ? 'var(--sev-high)' :
                'var(--text-muted)'
              }
            />
            <span style={{
              position: 'absolute', bottom: 1, right: 4,
              fontSize: 8, fontFamily: 'var(--font-mono)',
              color: 'var(--text-muted)', letterSpacing: '0.10em',
              opacity: 0.6,
            }}>14d</span>
          </div>
        ) : (
          <div style={{
            height: 32,
            background: 'var(--border-base)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{
              fontSize: 9, color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
            }}>
              insufficient data
            </span>
          </div>
        )}
      </div>

      {/* Status alert */}
      {status === 'accelerating' && (
        <div className="mt-2 font-mono text-[10px] text-amber-400">
          {'\u26A0'} ACCELERATING: activity up &gt;50% vs prior week
        </div>
      )}
      {status === 'pivot' && (
        <div className="mt-2 font-mono text-[10px]" style={{ color: 'var(--blue)' }}>
          {'\u2192'} PIVOT DETECTED: went silent {provider.trend_30d ?? 0 > 50 ? '7+ days ago' : 'recently'}
        </div>
      )}
    </Card>
  );
}

// ─── Provider Detail Panel ───────────────────────────────────

function ProviderDetailPanel({ providerId }: { providerId: string }) {
  const { data: detail, isLoading: detailLoading } = useProviderDetail(providerId);
  const { data: threats, isLoading: threatsLoading } = useProviderThreats(providerId, { limit: 10 });
  const { data: timeline, isLoading: timelineLoading } = useProviderTimeline(providerId);
  const { data: linkedClusters, isLoading: clustersLoading } = useProviderClusters(providerId);

  if (detailLoading) {
    return (
      <Card padding="24px">
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        </div>
      </Card>
    );
  }

  if (!detail) return null;

  // Build chart data from timeline
  const chartData = timeline
    ? timeline.labels.map((label: string, i: number) => ({
        date: label.slice(5), // show MM-DD
        count: timeline.values[i],
      }))
    : [];

  function severityBadge(severity: string) {
    const map: Record<string, string> = {
      critical: 'bg-[#f87171]/10 text-[#f87171] border-[#f87171]/30',
      high: 'bg-[#fb923c]/10 text-[#fb923c] border-[#fb923c]/30',
      medium: 'bg-[#fbbf24]/10 text-[#fbbf24] border-[#fbbf24]/30',
      low: 'bg-[#60a5fa]/10 text-[#60a5fa] border-[#60a5fa]/30',
    };
    return map[severity] ?? map.low;
  }

  return (
    <Card variant="elevated" padding="24px">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">{countryFlag(detail.country)}</span>
            <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{detail.name}</h3>
          </div>
          <div className="font-mono text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {detail.asn || 'No ASN'} {detail.country ? `\u00B7 ${detail.country}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {detail.reputation_score !== null && (
            <div className="text-center">
              <div className={`font-display text-2xl font-bold ${
                detail.reputation_score >= 80 ? 'text-[#4ADE80]'
                : detail.reputation_score >= 60 ? 'text-[#fbbf24]'
                : detail.reputation_score >= 40 ? 'text-[#fb923c]'
                : 'text-[#f87171]'
              }`}>
                {detail.reputation_score}
              </div>
              <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Reputation</div>
            </div>
          )}
        </div>
      </div>

      {/* Abuse channel — from takedown_providers directory. Sparrow uses
          this to route takedown filings; surfacing it here proves the
          channel is wired. Hidden entirely when no directory match. */}
      {detail.abuse_contact && (
        <div className="mb-6 pb-6" style={{ borderBottom: '1px solid var(--border-base)' }}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
              Abuse channel
            </div>
            <Badge size="xs">{detail.abuse_contact.provider_type.replace('_', ' ')}</Badge>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {detail.abuse_contact.abuse_email && (
              <div className="flex items-start gap-2">
                <Mail size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--text-muted)' }}>
                    Email
                  </div>
                  <a
                    href={`mailto:${detail.abuse_contact.abuse_email}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-sm break-all font-mono hover:underline"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {detail.abuse_contact.abuse_email}
                  </a>
                </div>
              </div>
            )}
            {detail.abuse_contact.abuse_url && (
              <div className="flex items-start gap-2">
                <ExternalLink size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--text-muted)' }}>
                    Report URL
                  </div>
                  <a
                    href={detail.abuse_contact.abuse_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-sm break-all font-mono hover:underline"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {detail.abuse_contact.abuse_url.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              </div>
            )}
            {detail.abuse_contact.abuse_api_url && (
              <div className="flex items-start gap-2">
                <Zap size={14} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--amber)' }} />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--text-muted)' }}>
                    API {detail.abuse_contact.abuse_api_type ? `· ${detail.abuse_contact.abuse_api_type}` : ''}
                  </div>
                  <span className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                    {detail.abuse_contact.abuse_api_url.replace(/^https?:\/\//, '')}
                  </span>
                </div>
              </div>
            )}
          </div>
          {(detail.abuse_contact.avg_response_hours != null || detail.abuse_contact.success_rate != null) && (
            <div className="grid grid-cols-2 gap-4 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-base)' }}>
              {detail.abuse_contact.avg_response_hours != null && (
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Avg response
                  </div>
                  <div className="text-base font-mono" style={{ color: 'var(--text-primary)' }}>
                    {detail.abuse_contact.avg_response_hours}h
                  </div>
                </div>
              )}
              {detail.abuse_contact.success_rate != null && (
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Success rate
                  </div>
                  <div className="text-base font-mono" style={{ color: 'var(--text-primary)' }}>
                    {Math.round(detail.abuse_contact.success_rate * 100)}%
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Three columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left — Provider Info */}
        <div className="space-y-3">
          <div className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
            Provider Details
          </div>
          <div className="space-y-2">
            {[
              ['First Threat', detail.first_seen ? new Date(detail.first_seen).toLocaleDateString() : 'N/A'],
              ['Last Threat', detail.last_seen ? new Date(detail.last_seen).toLocaleDateString() : 'N/A'],
              ['Total Threats', String(detail.total_threats)],
              ['Active Threats', String(detail.active_threats)],
              ['Brands Targeted', String(detail.brands_targeted)],
              ['Campaigns', String(detail.campaigns)],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
                <span className="font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Center — Timeline Chart */}
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
            Threat Timeline (30d)
          </div>
          {timelineLoading ? (
            <Skeleton className="h-40" />
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="tealGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00D4FF" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#00D4FF" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fill: '#78A0C8', opacity: 0.5 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0D1520',
                    border: '1px solid var(--border-base)',
                    borderRadius: '8px',
                    fontSize: '11px',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}
                  labelStyle={{ color: '#78A0C8' }}
                  itemStyle={{ color: '#00D4FF' }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="#00D4FF"
                  fill="url(#tealGradient)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-40 flex items-center justify-center font-mono text-[11px] text-white/40">
              No timeline data
            </div>
          )}
        </div>

        {/* Right — Linked Clusters */}
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
            Linked Clusters
          </div>
          {clustersLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          ) : linkedClusters && linkedClusters.length > 0 ? (
            <div className="space-y-2">
              {linkedClusters.map(cluster => (
                <Card key={cluster.id} padding="10px">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                      {cluster.cluster_name || `Cluster ${cluster.id.slice(0, 8)}`}
                    </span>
                    <StatusBadge status={getClusterStatus(cluster)} />
                  </div>
                  <div className="font-mono text-[10px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    {cluster.threat_count} threats
                    {cluster.agent_notes && (
                      <span className="block mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>{cluster.agent_notes}</span>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="font-mono text-[11px] text-white/40 py-4 text-center">
              No cluster linkage
            </div>
          )}
        </div>
      </div>

      {/* Recent Threats Table */}
      <div className="mt-6">
        <div className="font-mono text-[9px] uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
          Recent Threats
        </div>
        {threatsLoading ? (
          <Skeleton className="h-32" />
        ) : threats && threats.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {['Type', 'Domain', 'Severity', 'First Seen'].map(h => (
                    <th key={h} className="font-mono text-[9px] uppercase tracking-wider text-left py-2 px-2" style={{ color: 'var(--text-tertiary)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {threats.map(threat => (
                  <tr key={threat.id} className="data-row border-b border-white/[0.04]">
                    <td className="font-mono text-[11px] py-1.5 px-2" style={{ color: 'var(--text-primary)' }}>{threat.threat_type}</td>
                    <td className="font-mono text-[11px] py-1.5 px-2 truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }}>
                      {threat.malicious_domain || '—'}
                    </td>
                    <td className="py-1.5 px-2">
                      <span className={`inline-flex font-mono text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${severityBadge(threat.severity)}`}>
                        {threat.severity}
                      </span>
                    </td>
                    <td className="font-mono text-[10px] text-white/50 py-1.5 px-2">
                      {threat.first_seen ? new Date(threat.first_seen).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Globe />}
            title="No infrastructure detected"
            subtitle="Provider intelligence populates as threats are analyzed and ASNs are identified"
            variant="scanning"
            compact
          />
        )}
      </div>
    </Card>
  );
}

// ─── Filter Bar ──────────────────────────────────────────────

const STATUS_FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'active', label: 'ACTIVE' },
  { id: 'accelerating', label: 'ACCELERATING' },
  { id: 'pivot', label: 'PIVOTS' },
  { id: 'quiet', label: 'QUIET' },
] as const;

const SORT_OPTIONS = [
  { id: 'active_threats', label: 'THREAT COUNT' },
  { id: 'trend_7d', label: '7D TREND' },
  { id: 'trend_30d', label: '30D TREND' },
] as const;

// ─── Main Page ───────────────────────────────────────────────

export function Providers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get('focus');

  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('active_threats');
  // ?q= lets the command palette's "view all" pivot land here pre-filtered
  // (Tier-2) — useProviders already sends `search` through as `q`, so this
  // only needed a seed; read once as the initial value.
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);

  // Deep-link target: a pivot (Campaign→Provider, notification) lands here with
  // ?focus=:id. Clear filters so the provider is in the list, select it, queue
  // a one-shot scroll, then strip the param so a later collapse won't re-fire.
  useEffect(() => {
    if (!focusId) return;
    setStatusFilter('all');
    setSearch('');
    setSelectedClusterId(null);
    setSelectedProviderId(focusId);
    setPendingScrollId(focusId);
    setSearchParams({}, { replace: true });
  }, [focusId, setSearchParams]);

  const { data: intelligence, isLoading: intelLoading } = useProviderIntelligence();
  const { data: clusters, isLoading: clustersLoading } = useClusters();
  const { data: providers, isLoading: providersLoading } = useProviders({
    limit: 50,
    sort: sortBy,
    status: statusFilter === 'all' ? undefined : statusFilter,
    search: search || undefined,
    clusterId: selectedClusterId || undefined,
  });

  // Scroll the focused card into view once it's rendered, exactly once.
  useEffect(() => {
    if (!pendingScrollId) return;
    const el = document.getElementById(`provider-detail-${pendingScrollId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setPendingScrollId(null);
    }
  }, [pendingScrollId, providers]);

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader title="Hosting Providers" subtitle="Infrastructure hosting threat activity" />

      <StatGrid cols={4}>
        <StatCard
          label="Providers Tracked"
          value={intelLoading ? '—' : (intelligence?.total_providers ?? 0).toLocaleString()}
          sublabel={`${intelligence?.total_clusters ?? 0} clusters`}
        />
        <StatCard
          label="Active Operations"
          value={intelLoading ? '—' : (intelligence?.active_operations ?? 0).toLocaleString()}
          accentColor="var(--green)"
          sublabel="Providers with active threats"
        />
        <StatCard
          label="Accelerating"
          value={intelLoading ? '—' : (intelligence?.accelerating ?? 0).toLocaleString()}
          accentColor="var(--amber)"
          sublabel="7d trend > 30d average"
        />
        <StatCard
          label="Pivots Detected"
          value={intelLoading ? '—' : (intelligence?.pivots_detected ?? 0).toLocaleString()}
          accentColor="var(--red)"
          sublabel="Silent after >50 threats/30d"
        />
      </StatGrid>

      {/* Three Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        {/* Left Sidebar — Cluster Intelligence */}
        <div className="lg:max-h-[calc(100vh-320px)] lg:overflow-y-auto lg:pr-1 scrollbar-thin">
          <ClusterPanel
            clusters={clusters ?? []}
            isLoading={clustersLoading}
            selectedClusterId={selectedClusterId}
            onSelect={id => {
              setSelectedClusterId(id);
              setSelectedProviderId(null);
            }}
          />
        </div>

        {/* Center/Main — Provider Cards */}
        <div className="space-y-4">
          <FilterBar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: 'Search providers or ASN...',
            }}
            filters={STATUS_FILTERS.map(f => ({ value: f.id, label: f.label }))}
            active={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setSelectedProviderId(null);
            }}
            actions={
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Sort:</span>
                {SORT_OPTIONS.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setSortBy(s.id)}
                    className="font-mono text-[10px] font-semibold px-2 py-0.5 rounded transition-all"
                    style={{
                      background: sortBy === s.id ? 'var(--border-base)' : 'transparent',
                      color: sortBy === s.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            }
          />

          {/* Provider Cards Grid */}
          {providersLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-48 rounded-xl" />
              ))}
            </div>
          ) : providers && providers.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {providers.map(provider => (
                <Fragment key={provider.id}>
                  <ProviderCard
                    provider={provider}
                    clusters={clusters ?? []}
                    isSelected={selectedProviderId === provider.id}
                    onSelect={(id) => setSelectedProviderId(prev => prev === id ? null : id)}
                  />
                  {selectedProviderId === provider.id && (
                    <div className="col-span-full" id={`provider-detail-${provider.id}`}>
                      <ProviderDetailPanel providerId={provider.id} />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          ) : (
            <Card padding="48px" className="text-center">
              <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                No providers match current filters
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
