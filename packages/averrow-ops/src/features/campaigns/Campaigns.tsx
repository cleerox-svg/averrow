import { Fragment, useEffect, useState, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Badge,
  Card,
  StatCard,
  StatGrid,
  PageHeader,
  EmptyState,
  EntityListShell,
  type EntityListSort,
} from '@/design-system/components';
import { TrendSparkline } from '@/components/ui/TrendSparkline';
import { Skeleton } from '@/components/ui/Skeleton';
import { CardGridLoader } from '@/components/ui/PageLoader';
import { useCampaigns, useCampaignStats } from '@/hooks/useCampaigns';
import {
  useOperations,
  useOperationsStats,
  useOperationTimeline,
  useOperationThreats,
} from '@/hooks/useOperations';
import type { Operation } from '@/hooks/useOperations';
import { useGeopoliticalCampaigns } from '@/hooks/useGeopoliticalCampaign';
import type { GeopoliticalCampaign } from '@/hooks/useGeopoliticalCampaign';
import { Activity, ChevronDown } from 'lucide-react';

// ─── Helpers ──────────────────────────────────────────────────

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try { return JSON.parse(val) as string[]; }
  catch { return []; }
}

function formatDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Status Badge ─────────────────────────────────────────────

type OpStatus = 'accelerating' | 'pivot' | 'active' | 'dormant';

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase() as OpStatus;
  // Bundle C R8 migration: use the Badge.context tags instead of
  // overloading `status` with custom labels. Notable semantic fix:
  // PIVOT was previously rendered as `status="active"` which is the
  // healthy GREEN color. But "pivot" means "infrastructure went
  // silent recently \u2014 possibly evading takedowns" \u2014 that should
  // read as critical/red, not as green/healthy. Badge.context.pivot
  // is dedicated red. Same fix as Providers (#1085).
  switch (s) {
    case 'accelerating': return <Badge context="accelerating" size="xs" />;
    case 'pivot':        return <Badge context="pivot" size="xs" />;
    case 'active':       return <Badge status="active"   label="Active" size="xs" />;
    default:             return <Badge status="inactive" label="Dormant" size="xs" />;
  }
}

// ─── Attack Type Badge ────────────────────────────────────────

function AttackTypeBadge({ type }: { type: string | null }) {
  if (!type) return null;
  const t = type.toLowerCase();
  let cls = 'border-white/10 bg-white/5 text-white/40';
  if (t.includes('phishing')) cls = 'border-[#C83C3C]/30 bg-[#C83C3C]/10 text-[#C83C3C]';
  else if (t.includes('malware')) cls = 'border-[#FB923C]/30 bg-[#FB923C]/10 text-[#FB923C]';
  else if (t === 'c2') cls = 'border-[#A78BFA]/30 bg-[#A78BFA]/10 text-[#A78BFA]';
  else if (t.includes('credential')) cls = 'border-[#F97316]/30 bg-[#F97316]/10 text-[#F97316]';

  return (
    <span className={`inline-flex font-mono text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${cls}`}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

// ─── Severity + color helpers ─────────────────────────────────

function opSeverity(count: number): 'critical' | 'high' | 'medium' | 'low' {
  if (count > 3000) return 'critical';
  if (count > 1000) return 'high';
  if (count > 300)  return 'medium';
  return 'low';
}

function opAccent(sev: string): string {
  switch (sev) {
    case 'critical': return 'var(--sev-critical)';
    case 'high':     return 'var(--sev-high)';
    case 'medium':   return 'var(--amber)';
    default:         return 'var(--text-muted)';
  }
}

function confidenceColor(score: number | null): string {
  if (score == null)  return 'var(--text-muted)';
  if (score >= 90)    return 'var(--sev-info)';
  if (score >= 70)    return 'var(--amber)';
  return 'var(--sev-critical)';
}

function asnColor(asn: string): string {
  if (asn.includes('CN') || asn.includes('4837') || asn.includes('4134')) return 'var(--sev-high)';
  if (asn.includes('RU') || asn.includes('8359') || asn.includes('12389')) return 'var(--blue)';
  if (asn.includes('IR') || asn.includes('44244')) return 'var(--red)';
  if (asn.includes('KP')) return 'var(--sev-medium)';
  return 'var(--text-muted)';
}

// ─── Operation Card (Tier 1) ──────────────────────────────────

function OperationCard({
  operation,
  isSelected,
  onSelect,
}: {
  operation: Operation;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const asns      = parseJsonArray(operation.asns);
  const countries = parseJsonArray(operation.countries);
  const primaryAsn = asns[0] ?? '';
  const sparkData = operation.threat_history ?? [];

  // Agents/Feeds pattern: calm `elevated` Card by default, `critical`
  // only when status reflects a problem state. No severity left-stripe;
  // metric values stay plain `--text-primary` and only color signals
  // problems (errors / accelerating / pivot).
  const isProblemState = operation.status === 'pivot';
  const variant: 'elevated' | 'critical' | 'active' =
    isSelected ? 'active' : isProblemState ? 'critical' : 'elevated';

  return (
    <Card
      variant={variant}
      hover={!isSelected}
      onClick={() => onSelect(operation.id)}
      className="p-4 flex flex-col gap-3 cursor-pointer transition-all"
    >
      {/* Header: ASN chip + name + status badge + chevron */}
      <div className="flex items-center gap-3">
        {primaryAsn && (
          <span
            className="flex-shrink-0 font-mono text-[9px] font-bold uppercase tracking-[0.12em] px-1.5 py-1 rounded"
            style={{
              color: asnColor(primaryAsn),
              background: `${asnColor(primaryAsn)}15`,
              border: `1px solid ${asnColor(primaryAsn)}35`,
            }}
          >
            {primaryAsn}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-mono text-[13px] font-bold uppercase tracking-wide truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {operation.cluster_name || `Cluster ${operation.id.slice(0, 8)}`}
            </span>
            <StatusBadge status={operation.status} />
            {operation.actor_id && operation.actor_name && (
              <Link
                to={`/threat-actors/${operation.actor_id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-mono text-[9px] font-bold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded transition-colors hover:underline"
                style={{
                  color: 'var(--blue)',
                  background: 'rgba(10, 138, 181, 0.10)',
                  border: '1px solid rgba(10, 138, 181, 0.30)',
                }}
                title={`Attributed to ${operation.actor_name}`}
              >
                {operation.actor_name}
              </Link>
            )}
          </div>
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            {operation.first_detected
              ? `Since ${formatDate(operation.first_detected)}`
              : 'Detection date unknown'}
            {countries.length > 0 && (
              <> \u00B7 <span style={{ color: 'var(--text-muted)' }}>
                {countries.slice(0, 4).map(c => countryFlag(c)).join(' ')}
                {countries.length > 4 && ` +${countries.length - 4}`}
              </span></>
            )}
          </div>
        </div>
        <ChevronDown
          size={14}
          style={{
            color: 'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform: isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        />
      </div>

      {/* Metrics row + top-right sparkline */}
      <div className="flex items-end justify-between gap-3">
        <div className="grid grid-cols-3 gap-2 text-[10px] font-mono flex-1">
          <div>
            <div style={{ color: 'var(--text-muted)' }}>THREATS</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>
              {operation.threat_count.toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>CONFIDENCE</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>
              {operation.confidence_score != null ? `${operation.confidence_score}%` : '\u2014'}
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)' }}>COUNTRIES</div>
            <div className="text-base" style={{ color: 'var(--text-primary)' }}>
              {countries.length}
            </div>
          </div>
        </div>
        {sparkData.length >= 2 && (
          <div className="flex flex-col items-end gap-1">
            <div style={{ width: 120, height: 36 }}>
              <TrendSparkline
                data={sparkData}
                fill
                height={36}
                color={isProblemState ? 'var(--sev-high)' : 'var(--amber)'}
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

      {/* Status / notes footer */}
      {(operation.status === 'accelerating' || operation.status === 'pivot' || operation.agent_notes) && (
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {operation.status === 'accelerating' && '\u2191 Accelerating \u2014 activity up vs prior week'}
          {operation.status === 'pivot' && '\u2192 Pivot detected \u2014 infrastructure migration'}
          {operation.status !== 'accelerating' && operation.status !== 'pivot' && operation.agent_notes}
        </div>
      )}
    </Card>
  );
}

// ─── Operation Detail Panel ───────────────────────────────────

function OperationDetailPanel({ operationId, operation }: { operationId: string; operation: Operation }) {
  const { data: timeline, isLoading: timelineLoading } = useOperationTimeline(operationId);
  const { data: threats, isLoading: threatsLoading } = useOperationThreats(operationId, { limit: 10 });

  const asns = parseJsonArray(operation.asns);
  const countries = parseJsonArray(operation.countries);

  const chartData = timeline
    ? timeline.labels.map((label: string, i: number) => ({
        date: label.slice(5),
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
    <Card variant="active" className="animate-fade-in" padding="24px">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            {countries[0] && <span className="text-xl">{countryFlag(countries[0])}</span>}
            <h3 className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
              {operation.cluster_name || `Cluster ${operation.id.slice(0, 8)}`}
            </h3>
          </div>
          <div className="font-mono text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {asns.join(', ')} {countries.length > 0 ? `\u00B7 ${countries.map(countryFlag).join(' ')}` : ''}
          </div>
        </div>
        <StatusBadge status={operation.status} />
      </div>

      {/* Three columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left — Cluster Info */}
        <div className="space-y-3">
          <div className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
            Operation Details
          </div>
          <div className="space-y-2">
            {[
              ['First Detected', formatDate(operation.first_detected)],
              ['Last Seen', formatDate(operation.last_seen)],
              ['Total Threats', String(operation.threat_count)],
              ['Confidence', operation.confidence_score != null ? `${operation.confidence_score}%` : 'N/A'],
              ['ASNs', asns.join(', ') || 'N/A'],
              ['Countries', countries.join(', ') || 'N/A'],
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
                  <linearGradient id="opsTealGradient" x1="0" y1="0" x2="0" y2="1">
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
                    fontFamily: 'IBM Plex Mono, monospace',
                  }}
                  labelStyle={{ color: '#78A0C8' }}
                  itemStyle={{ color: '#00D4FF' }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="#00D4FF"
                  fill="url(#opsTealGradient)"
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

        {/* Right — Agent Notes */}
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
            NEXUS Intelligence
          </div>
          {operation.agent_notes ? (
            <Card padding="12px">
              <div className="font-mono text-[11px] leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                {operation.agent_notes}
              </div>
            </Card>
          ) : (
            <div className="font-mono text-[11px] py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>
              No intelligence notes
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
                {threats.map((threat, i) => (
                  <tr key={String(threat.id ?? i)} className="data-row border-b border-white/[0.04]">
                    <td className="font-mono text-[11px] py-1.5 px-2" style={{ color: 'var(--text-primary)' }}>{String(threat.threat_type ?? '—')}</td>
                    <td className="font-mono text-[11px] py-1.5 px-2 truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }}>
                      {String(threat.malicious_domain ?? '—')}
                    </td>
                    <td className="py-1.5 px-2">
                      <span className={`inline-flex font-mono text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${severityBadge(String(threat.severity ?? 'low'))}`}>
                        {String(threat.severity ?? '—')}
                      </span>
                    </td>
                    <td className="font-mono text-[10px] text-white/50 py-1.5 px-2">
                      {threat.first_seen ? new Date(String(threat.first_seen)).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Activity />}
            title="No threats linked"
            subtitle="Threats will appear as they are correlated to this operation"
            variant="clean"
            compact
          />
        )}
      </div>
    </Card>
  );
}

// ─── Campaign Card (Tier 2) ──────────────────────────────────

interface Campaign {
  id: string;
  name: string;
  first_seen: string;
  last_seen: string;
  threat_count: number;
  brand_count: number;
  provider_count: number;
  attack_pattern: string | null;
  status: string;
}

function CampaignCard({
  campaign,
  onClick,
}: {
  campaign: Campaign;
  onClick: () => void;
}) {
  let attackType: string | null = null;
  if (campaign.attack_pattern) {
    try {
      const parsed = JSON.parse(campaign.attack_pattern);
      attackType = parsed.type ?? parsed.attack_type ?? campaign.attack_pattern;
    } catch {
      attackType = campaign.attack_pattern;
    }
  }

  const status = (campaign.status ?? 'active').toLowerCase();

  return (
    <Card
      variant="elevated"
      hover
      onClick={onClick}
      className="p-4 flex flex-col gap-3 cursor-pointer transition-all"
    >
      {/* Header: name (mono caps) + status badge */}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-mono text-[13px] font-bold uppercase tracking-wide truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {campaign.name}
            </span>
            <Badge
              status={status === 'active' ? 'active' : 'inactive'}
              label={status === 'active' ? 'Active' : 'Dormant'}
              size="xs"
              pulse={status === 'active'}
            />
          </div>
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            Since {formatDate(campaign.first_seen)} {'\u00B7'} Last seen {formatDate(campaign.last_seen)}
          </div>
        </div>
      </div>

      {/* Metrics row (label-above-value, plain colors) */}
      <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
        <div>
          <div style={{ color: 'var(--text-muted)' }}>THREATS</div>
          <div className="text-base" style={{ color: 'var(--text-primary)' }}>
            {campaign.threat_count.toLocaleString()}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>BRANDS</div>
          <div className="text-base" style={{ color: 'var(--text-primary)' }}>
            {campaign.brand_count.toLocaleString()}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>PROVIDERS</div>
          <div className="text-base" style={{ color: 'var(--text-primary)' }}>
            {campaign.provider_count.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Attack-type pill (footer \u2014 parallels Agents COMPLIANCE chips) */}
      {attackType && (
        <div className="flex flex-wrap gap-1">
          <AttackTypeBadge type={attackType} />
        </div>
      )}
    </Card>
  );
}

// ─── Geopolitical Campaign Card ──────────────────────────────

function GeoCampaignCard({
  campaign,
  onClick,
}: {
  campaign: GeopoliticalCampaign;
  onClick: () => void;
}) {
  const adversaryCountries = parseJsonArray(campaign.adversary_countries);
  const targetCountries = parseJsonArray(campaign.target_countries);
  const threatActors = parseJsonArray(campaign.threat_actors);

  const status = (campaign.status ?? 'active').toLowerCase();

  return (
    <Card
      variant="elevated"
      hover
      onClick={onClick}
      className="p-4 flex flex-col gap-3 cursor-pointer transition-all"
    >
      {/* Header: name (mono caps) + status badge + Geopolitical eyebrow */}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="font-mono text-[13px] font-bold uppercase tracking-wide truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {campaign.name}
            </span>
            <Badge
              status={status === 'active' ? 'active' : 'inactive'}
              label={status.charAt(0).toUpperCase() + status.slice(1)}
              size="xs"
              pulse={status === 'active'}
            />
            <span
              className="ml-auto font-mono text-[9px] font-bold uppercase tracking-[0.18em]"
              style={{ color: 'var(--text-muted)' }}
            >
              Geopolitical
            </span>
          </div>
          {campaign.description && (
            <div
              className="font-mono text-[10px] mt-0.5 line-clamp-2"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {campaign.description}
            </div>
          )}
        </div>
      </div>

      {/* Metrics row: adversary count / target count / actor count */}
      <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
        <div>
          <div style={{ color: 'var(--text-muted)' }}>ADVERSARY</div>
          <div className="text-base flex items-center gap-1" style={{ color: 'var(--text-primary)' }}>
            <span>{adversaryCountries.length}</span>
            <span className="text-xs">
              {adversaryCountries.slice(0, 3).map(c => countryFlag(c)).join(' ')}
            </span>
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>TARGETS</div>
          <div className="text-base flex items-center gap-1" style={{ color: 'var(--text-primary)' }}>
            <span>{targetCountries.length}</span>
            <span className="text-xs">
              {targetCountries.slice(0, 3).map(c => countryFlag(c)).join(' ')}
            </span>
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>ACTORS</div>
          <div
            className="text-base"
            style={{ color: threatActors.length > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            {threatActors.length}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Filter Constants ─────────────────────────────────────────

const ATTACK_FILTERS = [
  { id: 'all', label: 'ALL' },
  { id: 'phishing', label: 'PHISHING' },
  { id: 'malware', label: 'MALWARE' },
  { id: 'c2', label: 'C2' },
] as const;

const CAMP_SORTS: EntityListSort<Campaign>[] = [
  { id: 'threats', label: 'THREAT COUNT', compare: (a, b) => b.threat_count - a.threat_count },
  { id: 'brands',  label: 'BRAND COUNT',  compare: (a, b) => b.brand_count - a.brand_count },
  { id: 'recent',  label: 'MOST RECENT',  compare: (a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime() },
];

// ─── Main Page ────────────────────────────────────────────────

export function Campaigns() {
  const navigate = useNavigate();
  // ?focus=<cluster id> pre-expands an operation card — the pivot target
  // for Attribution Backlog rows (same pattern as /providers?focus=).
  const [searchParams] = useSearchParams();
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    () => searchParams.get('focus'),
  );
  const [attackFilter, setAttackFilter] = useState('all');
  // ?q= lets the command palette's "view all" pivot land here pre-filtered
  // (Tier-2) — same seed pattern as Threats.tsx / ThreatActors.tsx.
  // EntityListShell gets this as a controlled search box; each keystroke
  // re-queries handleListCampaignsV2's name-prefix match too.
  const [campaignSearch, setCampaignSearch] = useState(() => searchParams.get('q') ?? '');

  // Data fetching. A ?focus= pivot may target a cluster outside the default
  // top-12, so widen to the API max when focusing and scroll the card in.
  const focusId = searchParams.get('focus');
  const { data: opsStats, isLoading: opsStatsLoading } = useOperationsStats();
  const { data: operations, isLoading: opsLoading } = useOperations({ limit: focusId ? 100 : 12 });

  useEffect(() => {
    if (!focusId || !operations?.length) return;
    // The wrapper is display:contents (keeps the grid layout intact), so
    // scroll its first real child — the card element.
    const anchor = document.getElementById(`op-${focusId}`);
    (anchor?.firstElementChild ?? anchor)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusId, operations]);
  const { data: campaignsRes, isLoading: campaignsLoading } = useCampaigns({
    status: 'active',
    limit: 50,
    search: campaignSearch || undefined,
  });
  const { data: campStats } = useCampaignStats();
  const { data: geoCampaigns, isLoading: geoLoading } = useGeopoliticalCampaigns();

  const allOperations = operations ?? [];
  const allCampaigns = (campaignsRes ?? []) as Campaign[];

  // Segment (attack-type) filtering stays here; search/sort/pagination are
  // owned by the shared EntityListShell below.
  const attackFilteredCampaigns = useMemo(() => {
    if (attackFilter === 'all') return allCampaigns;
    return allCampaigns.filter(c =>
      c.attack_pattern ? c.attack_pattern.toLowerCase().includes(attackFilter) : false,
    );
  }, [allCampaigns, attackFilter]);

  if (opsLoading && campaignsLoading) return <CardGridLoader count={9} />;

  return (
    <div className="animate-fade-in space-y-8">
      {/* Page Title */}
      <PageHeader
        title="Threat Campaigns"
        subtitle="Active adversary operations targeting monitored brands"
      />

      {/* ─── Header Stats (4 cards) ─────────────────────────────── */}
      <StatGrid cols={4}>
        <StatCard
          label="Active Operations"
          value={opsStatsLoading ? '—' : (opsStats?.active_operations ?? 0).toLocaleString()}
          accentColor="var(--green)"
        />
        <StatCard
          label="Campaigns Tracked"
          value={opsStatsLoading ? '—' : (opsStats?.campaigns_tracked ?? 0).toLocaleString()}
          accentColor="var(--amber)"
        />
        <StatCard
          label="Brands Targeted"
          value={opsStatsLoading ? '—' : (opsStats?.brands_targeted ?? 0).toLocaleString()}
          accentColor="var(--red)"
        />
        <StatCard
          label="Threat Types"
          value={opsStatsLoading ? '—' : (() => {
            const raw: unknown = opsStats?.threat_types;
            if (raw == null) return '0';
            if (typeof raw === 'number') return raw.toLocaleString();
            if (typeof raw === 'string') return raw;
            if (Array.isArray(raw)) return raw.join(', ');
            if (typeof raw === 'object') return Object.keys(raw).join(', ');
            return String(raw);
          })()}
          accentColor="var(--amber)"
        />
      </StatGrid>

      {/* ─── Section A: Threat Actor Operations ────────────────── */}
      <section>
        <div className="mb-4">
          <div className="section-label font-mono font-bold mb-1">
            NEXUS Correlated Operations
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Infrastructure-level operations detected by NEXUS correlation engine
          </div>
        </div>

        {opsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-xl" />
            ))}
          </div>
        ) : allOperations.length > 0 ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {allOperations.map(op => (
                <Fragment key={op.id}>
                  <div id={`op-${op.id}`} className="contents">
                    <OperationCard
                      operation={op}
                      isSelected={selectedOperationId === op.id}
                      onSelect={id => setSelectedOperationId(selectedOperationId === id ? null : id)}
                    />
                  </div>
                  {selectedOperationId === op.id && (
                    <div className="col-span-full">
                      <OperationDetailPanel
                        operationId={op.id}
                        operation={op}
                      />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>

            {(opsStats?.total_clusters ?? 0) > 12 && (
              <div className="mt-3 text-center">
                <span className="font-mono text-[11px] text-white/55">
                  Showing 12 of {opsStats?.total_clusters ?? 0} operations
                </span>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={<Activity />}
            title="No active threat operations"
            subtitle="Nexus will surface correlated attack clusters as threat data accumulates"
            variant="scanning"
          />
        )}
      </section>

      {/* ─── Section: Geopolitical Campaigns ─────────────────────── */}
      {(geoLoading || (geoCampaigns && geoCampaigns.length > 0)) && (
        <section>
          <div className="mb-4">
            <div className="section-label font-mono font-bold mb-1">
              Geopolitical Campaigns
            </div>
            <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              State-linked threat campaigns tracked by adversary country and ASN
            </div>
          </div>

          {geoLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(geoCampaigns ?? []).map(gc => (
                <GeoCampaignCard
                  key={gc.id}
                  campaign={gc}
                  onClick={() => navigate(`/campaigns/geo/${gc.id}`)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ─── Section B: Active Campaigns ───────────────────────── */}
      <section>
        <div className="mb-4">
          <div className="section-label font-mono font-bold mb-1">
            Active Campaigns
          </div>
          <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            IP-clustered campaigns tracked by Strategist agent
          </div>
        </div>

        <EntityListShell<Campaign>
          items={attackFilteredCampaigns}
          isLoading={campaignsLoading}
          getKey={(c) => c.id}
          filters={ATTACK_FILTERS.map(f => ({ value: f.id, label: f.label }))}
          activeFilter={attackFilter}
          onFilterChange={setAttackFilter}
          search={{
            placeholder: 'Search campaigns…',
            fields: (c) => [c.name],
            value: campaignSearch,
            onChange: setCampaignSearch,
          }}
          sorts={CAMP_SORTS}
          defaultSortId="threats"
          pageSize={12}
          gridClassName="grid grid-cols-1 md:grid-cols-2 gap-4"
          skeletonClassName="h-44 rounded-xl"
          empty={{
            title: 'No campaigns match current filters',
            subtitle: 'Try adjusting your filters to see more results',
          }}
          renderItem={(campaign) => (
            <CampaignCard
              campaign={campaign}
              onClick={() => navigate(`/campaigns/${campaign.id}`)}
            />
          )}
        />
      </section>
    </div>
  );
}
