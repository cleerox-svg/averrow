import { Fragment, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Card,
  StatTile,
  StatGrid,
  PageHeader,
  FilterBar,
  PageState,
  Skeleton,
  Badge,
  Sparkline,
  type BadgeProps,
  Table, Th, Td,
} from '@/design-system/components';
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

// ─── Status → Badge props ────────────────────────────────────
// Trend signals use Badge.context tags (PIVOT reads red, not the healthy
// run-state blue it once got by overloading `status`).
const PROVIDER_STATUS_BADGE: Record<ProviderStatus, BadgeProps> = {
  accelerating: { context: 'accelerating' },
  pivot:        { context: 'pivot' },
  active:       { status: 'active', label: 'ACTIVE' },
  quiet:        { context: 'quiet' },
};

// ─── Cluster Sidebar ─────────────────────────────────────────

function ClusterPanel({
  clusters,
  isLoading,
  isError,
  onRetry,
  selectedClusterId,
  onSelect,
}: {
  clusters: Cluster[];
  isLoading: boolean;
  /** Failed fetch with no usable data: shown as an error, never "no clusters". */
  isError: boolean;
  onRetry: () => void;
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
      {isError && (
        <PageState kind="error" layout="card" compact title="Couldn't load clusters" onRetry={onRetry} />
      )}
      {!isError && clusters.length === 0 && (
        <PageState
          kind="empty"
          layout="card"
          icon={<Globe />}
          title="No clusters detected"
          description="Infrastructure clusters will appear as threat correlations are identified"
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
              <Badge {...PROVIDER_STATUS_BADGE[status]} size="xs" />
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

// ─── Provider Card (matches Brands architecture) ───

function ProviderCard({
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
  const coolingDelta =
    typeof provider.cooling_delta_7d === 'number' && provider.cooling_delta_7d < 0
      ? provider.cooling_delta_7d : null;
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
            <Badge {...PROVIDER_STATUS_BADGE[status]} size="xs" />
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
              <Sparkline
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
      {coolingDelta !== null && (
        <div
          className="font-mono text-[10px]"
          style={{ color: 'var(--green)' }}
          aria-label={formatCoolingDelta(coolingDelta).aria}
        >
          <span aria-hidden="true">{'↓'} {formatCoolingDelta(coolingDelta).text}</span>
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

// ─── Provider Detail Panel ───────────────────────────────────

function ProviderDetailPanel({ providerId }: { providerId: string }) {
  const { data: detail, isLoading: detailLoading } = useProviderDetail(providerId);
  const {
    data: threats, isLoading: threatsLoading, isError: threatsError, refetch: refetchThreats,
  } = useProviderThreats(providerId, { limit: 10 });
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
                    fontFamily: 'var(--font-mono)',
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
                    <Badge {...PROVIDER_STATUS_BADGE[getClusterStatus(cluster)]} size="xs" />
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
        {threatsError && !threats ? (
          <PageState kind="error" layout="card" compact title="Couldn't load recent threats" onRetry={() => { void refetchThreats(); }} />
        ) : threatsLoading ? (
          <Skeleton className="h-32" />
        ) : threats && threats.length > 0 ? (
          <div className="overflow-x-auto">
            <Table className="w-full">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {['Type', 'Domain', 'Severity', 'First Seen'].map(h => (
                    <Th key={h} className="p-0 font-mono text-[9px] uppercase tracking-wider text-left py-2 px-2" style={{ color: 'var(--text-tertiary)' }}>
                      {h}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {threats.map(threat => (
                  <tr key={threat.id} className="data-row border-b border-white/[0.04]">
                    <Td className="p-0 font-mono text-[11px] py-1.5 px-2" style={{ color: 'var(--text-primary)' }}>{threat.threat_type}</Td>
                    <Td className="p-0 font-mono text-[11px] py-1.5 px-2 truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }}>
                      {threat.malicious_domain || '—'}
                    </Td>
                    <Td className="p-0 py-1.5 px-2">
                      <span className={`inline-flex font-mono text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${severityBadge(threat.severity)}`}>
                        {threat.severity}
                      </span>
                    </Td>
                    <Td className="p-0 font-mono text-[10px] text-white/50 py-1.5 px-2">
                      {threat.first_seen ? new Date(threat.first_seen).toLocaleDateString() : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <PageState
            kind="empty"
            layout="card"
            icon={<Globe />}
            title="No infrastructure detected"
            description="Provider intelligence populates as threats are analyzed and ASNs are identified"
            compact
          />
        )}
      </div>
    </Card>
  );
}

// ─── Filter Bar ──────────────────────────────────────────────

/** "Cooling" is a server-side view of /api/providers/v2 (trend_7d < 0, most
 *  negative first), selected via `sort` rather than `status`. Kept in one
 *  place so the param is trivial to change. */
const COOLING_SORT = 'cooling';
const COOLING_FILTER_ID = 'cooling';

/** cooling_delta_7d (negative) → "12.4 fewer threats/wk vs 30-day avg". */
function formatCoolingDelta(delta: number): { text: string; aria: string } {
  const n = Math.round(Math.abs(delta) * 10) / 10;
  const num = Number.isInteger(n) ? String(n) : n.toFixed(1);
  const noun = n === 1 ? 'threat' : 'threats';
  return {
    text: `${num} fewer ${noun}/wk vs 30-day avg`,
    aria: `Down ${num} ${noun} per week versus the 30-day average`,
  };
}

const STATUS_FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'active', label: 'ACTIVE' },
  { id: 'accelerating', label: 'ACCELERATING' },
  { id: COOLING_FILTER_ID, label: 'COOLING' },
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
    // Strip only the one-shot focus param — the workspace owns `tab`.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('focus');
      return next;
    }, { replace: true });
  }, [focusId, setSearchParams]);

  const isCooling = statusFilter === COOLING_FILTER_ID;

  const { data: intelligence, isLoading: intelLoading, isError: intelError } = useProviderIntelligence();
  const {
    data: clusters, isLoading: clustersLoading, isError: clustersError,
    isPlaceholderData: clustersPlaceholder, refetch: refetchClusters,
  } = useClusters();
  const {
    data: providers, isLoading: providersLoading, isError: providersError,
    isPlaceholderData: providersPlaceholder, refetch: refetchProviders,
  } = useProviders({
    limit: 50,
    sort: isCooling ? COOLING_SORT : sortBy,
    status: statusFilter === 'all' || isCooling ? undefined : statusFilter,
    search: search || undefined,
    clusterId: selectedClusterId || undefined,
  });

  // null = still loading / failed (StatTile shows "—" or "Couldn't load"),
  // never a misleading 0 for a stat that has not arrived.
  const intelValue = (n: number | undefined): number | null =>
    intelligence ? (n ?? 0) : (intelLoading || intelError ? null : 0);
  const intelFailed = intelError && !intelligence;
  // A failed fetch is an error, never "no providers". keepPreviousData rows
  // belong to the previous filter, so they don't count as data on failure.
  const providersFailed = providersError && (!providers || providersPlaceholder);
  const clustersFailed = clustersError && (!clusters || clustersPlaceholder);

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
        <StatTile
          label="Providers Tracked"
          value={intelValue(intelligence?.total_providers)}
          error={intelFailed}
          sub={`${intelligence?.total_clusters ?? 0} clusters`}
        />
        <StatTile
          label="Active Operations"
          value={intelValue(intelligence?.active_operations)}
          error={intelFailed}
          accent="var(--green)"
          sub="Providers with active threats"
        />
        <StatTile
          label="Accelerating"
          value={intelValue(intelligence?.accelerating)}
          error={intelFailed}
          accent="var(--amber)"
          sub="7d trend > 30d average"
        />
        <StatTile
          label="Pivots Detected"
          value={intelValue(intelligence?.pivots_detected)}
          error={intelFailed}
          accent="var(--red)"
          sub="Silent after >50 threats/30d"
        />
      </StatGrid>

      {/* Three Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        {/* Left Sidebar — Cluster Intelligence */}
        <div className="lg:max-h-[calc(100vh-320px)] lg:overflow-y-auto lg:pr-1 scrollbar-thin">
          <ClusterPanel
            clusters={clusters ?? []}
            isLoading={clustersLoading}
            isError={clustersFailed}
            onRetry={() => { void refetchClusters(); }}
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
          {providersError && !providersFailed && (
            <PageState kind="error" layout="inline" title="Couldn't refresh providers" description="Showing the last loaded list." onRetry={() => { void refetchProviders(); }} />
          )}
          {providersFailed ? (
            <PageState kind="error" layout="card" title="Couldn't load providers" onRetry={() => { void refetchProviders(); }} />
          ) : providersLoading ? (
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
            <PageState
              kind="empty"
              layout="card"
              title={isCooling ? 'No providers cooling down this week' : 'No providers match'}
              description={isCooling
                ? 'No hosting provider has a falling 7-day threat trend right now.'
                : 'No providers match the current filters.'}
            />
          )}
        </div>
      </div>
    </div>
  );
}
