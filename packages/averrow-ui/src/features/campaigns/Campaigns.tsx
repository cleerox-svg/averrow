import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Badge,
  Card,
  StatCard,
  StatGrid,
  FilterBar,
  PageHeader,
  EmptyState,
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
import { Activity, Search } from 'lucide-react';

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
  const sev       = opSeverity(operation.threat_count);
  const accent    = opAccent(sev);
  const primaryAsn = asns[0] ?? '';

  const sparkData = operation.threat_history ?? [];

  return (
    <Card
      variant={isSelected ? 'active' : 'base'}
      hover={!isSelected}
      onClick={() => onSelect(operation.id)}
      style={{
        borderLeft: `3px solid ${accent}`,
        padding:    '14px 16px',
        cursor:     'pointer',
        position:   'relative',
        overflow:   'hidden',
      }}
    >
      {/* Header: status + ASN badge + country flags */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <StatusBadge status={operation.status} />

        {primaryAsn && (
          <span style={{
            fontSize:      9,
            fontFamily:    'var(--font-mono)',
            fontWeight:    800,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            padding:       '2px 7px',
            borderRadius:  5,
            color:         asnColor(primaryAsn),
            background:    `${asnColor(primaryAsn)}15`,
            border:        `1px solid ${asnColor(primaryAsn)}35`,
          }}>
            {primaryAsn}
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
          {countries.slice(0, 3).map(c => (
            <span key={c} style={{ fontSize: 14 }}>{countryFlag(c)}</span>
          ))}
          {countries.length > 3 && (
            <span style={{
              fontSize:   9,
              color:      'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
            }}>
              +{countries.length - 3}
            </span>
          )}
        </div>
      </div>

      {/* Cluster name */}
      <div style={{
        fontSize:     13,
        fontWeight:   700,
        color:        'var(--text-primary)',
        marginBottom: 3,
        overflow:     'hidden',
        textOverflow: 'ellipsis',
        whiteSpace:   'nowrap',
      }}>
        {operation.cluster_name || `Cluster ${operation.id.slice(0, 8)}`}
      </div>

      {/* Meta line */}
      <div style={{
        fontSize:     10,
        fontFamily:   'var(--font-mono)',
        color:        'var(--text-muted)',
        marginBottom: 12,
      }}>
        {primaryAsn}
        {operation.first_detected
          ? ` \u00B7 Since ${formatDate(operation.first_detected)}`
          : ''}
      </div>

      {/* Metric row */}
      <div style={{
        display:             'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap:                 12,
        paddingTop:          10,
        paddingBottom:       10,
        borderTop:           '1px solid var(--border-base)',
        borderBottom:        '1px solid var(--border-base)',
        marginBottom:        10,
      }}>
        <div>
          <div style={{
            fontSize:   18,
            fontWeight: 900,
            fontFamily: 'var(--font-mono)',
            color:      accent,
            lineHeight: 1,
            textShadow: `0 0 14px ${accent}60`,
          }}>
            {operation.threat_count.toLocaleString()}
          </div>
          <div style={{
            fontSize:      9,
            fontFamily:    'var(--font-mono)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color:         'var(--text-muted)',
            marginTop:     3,
          }}>
            Threats
          </div>
        </div>

        <div>
          <div style={{
            fontSize:   18,
            fontWeight: 900,
            fontFamily: 'var(--font-mono)',
            lineHeight: 1,
            color:      confidenceColor(operation.confidence_score),
          }}>
            {operation.confidence_score != null
              ? `${operation.confidence_score}%`
              : '\u2014'}
          </div>
          <div style={{
            fontSize:      9,
            fontFamily:    'var(--font-mono)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color:         'var(--text-muted)',
            marginTop:     3,
          }}>
            Confidence
          </div>
        </div>

        <div>
          <div style={{
            fontSize:   18,
            fontWeight: 900,
            fontFamily: 'var(--font-mono)',
            lineHeight: 1,
            color:      'var(--text-secondary)',
          }}>
            {countries.length}
          </div>
          <div style={{
            fontSize:      9,
            fontFamily:    'var(--font-mono)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color:         'var(--text-muted)',
            marginTop:     3,
          }}>
            Countries
          </div>
        </div>
      </div>

      {/* Sparkline */}
      {sparkData.length >= 2 ? (
        <div style={{ position: 'relative' }}>
          <TrendSparkline
            data={sparkData}
            fill
            height={28}
            color={accent}
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
          height: 28,
          background: 'rgba(255,255,255,0.02)',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            insufficient data
          </span>
        </div>
      )}

      {/* Status alerts */}
      {operation.status === 'accelerating' && (
        <div style={{
          marginTop:  8,
          fontSize:   10,
          fontFamily: 'var(--font-mono)',
          color:      'var(--amber)',
          display:    'flex',
          alignItems: 'center',
          gap:        5,
        }}>
          <span>{'\u26A0'}</span>
          <span>{'ACCELERATING \u2014 activity increasing'}</span>
        </div>
      )}
      {operation.status === 'pivot' && (
        <div style={{
          marginTop:  8,
          fontSize:   10,
          fontFamily: 'var(--font-mono)',
          color:      'var(--amber)',
          display:    'flex',
          alignItems: 'center',
          gap:        5,
        }}>
          <span>{'\u2192'}</span>
          <span>{'PIVOT DETECTED \u2014 infrastructure migration'}</span>
        </div>
      )}
      {operation.agent_notes && (
        <div style={{
          marginTop:    6,
          fontSize:     10,
          fontFamily:   'var(--font-mono)',
          color:        'var(--text-muted)',
          overflow:     'hidden',
          textOverflow: 'ellipsis',
          whiteSpace:   'nowrap',
        }}>
          {operation.agent_notes}
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
                    border: '1px solid rgba(255,255,255,0.1)',
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

  return (
    <Card hover onClick={onClick} className="w-full text-left">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <AttackTypeBadge type={attackType} />
      </div>

      {/* Name */}
      <div className="font-display text-sm font-semibold truncate mb-0.5" style={{ color: 'var(--text-primary)' }}>
        {campaign.name}
      </div>
      <div className="font-mono text-[10px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
        First seen {formatDate(campaign.first_seen)} {'\u00B7'} Last seen {formatDate(campaign.last_seen)}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-3 py-2 border-t border-white/[0.06]">
        <div>
          <div className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            {campaign.threat_count}
          </div>
          <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Threats</div>
        </div>
        <div>
          <div className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            {campaign.brand_count}
          </div>
          <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Brands</div>
        </div>
        <div>
          <div className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            {campaign.provider_count}
          </div>
          <div className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>Providers</div>
        </div>
      </div>
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

  return (
    <Card variant="critical" hover onClick={onClick} className="w-full text-left">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${
          campaign.status === 'active'
            ? 'bg-signal-red/20 text-red-400 border-signal-red/30 animate-pulse'
            : campaign.status === 'dormant'
              ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
              : 'bg-white/5 text-gauge-gray border-white/10'
        }`}>
          {campaign.status}
        </span>
        <span className="font-mono text-[9px] text-gauge-gray uppercase tracking-widest">
          Geopolitical
        </span>
      </div>

      {/* Name */}
      <div className="font-display text-sm font-semibold truncate mb-1" style={{ color: 'var(--text-primary)' }}>
        {campaign.name}
      </div>
      {campaign.description && (
        <div className="font-mono text-[10px] text-white/55 mb-3 line-clamp-2">
          {campaign.description}
        </div>
      )}

      {/* Country flags */}
      <div className="flex items-center gap-4 py-2 border-t border-white/[0.06]">
        <div>
          <div className="font-mono text-[8px] text-white/55 uppercase mb-0.5">Adversary</div>
          <div className="flex gap-1">
            {adversaryCountries.map(c => (
              <span key={c} className="text-sm" title={c}>{countryFlag(c)}</span>
            ))}
          </div>
        </div>
        <div>
          <div className="font-mono text-[8px] text-white/55 uppercase mb-0.5">Targets</div>
          <div className="flex gap-1">
            {targetCountries.map(c => (
              <span key={c} className="text-sm" title={c}>{countryFlag(c)}</span>
            ))}
          </div>
        </div>
        {threatActors.length > 0 && (
          <div className="ml-auto">
            <div className="font-mono text-[8px] text-white/55 uppercase mb-0.5">Actors</div>
            <div className="font-mono text-[10px] text-red-400">
              {threatActors.length} linked
            </div>
          </div>
        )}
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

const SORT_OPTIONS = [
  { id: 'threats', label: 'THREAT COUNT' },
  { id: 'brands', label: 'BRAND COUNT' },
  { id: 'recent', label: 'MOST RECENT' },
] as const;

// ─── Main Page ────────────────────────────────────────────────

export function Campaigns() {
  const navigate = useNavigate();
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [attackFilter, setAttackFilter] = useState('all');
  const [sortBy, setSortBy] = useState('threats');

  // Data fetching
  const { data: opsStats, isLoading: opsStatsLoading } = useOperationsStats();
  const { data: operations, isLoading: opsLoading } = useOperations({ limit: 12 });
  const { data: campaignsRes, isLoading: campaignsLoading } = useCampaigns({ status: 'active', limit: 50 });
  const { data: campStats } = useCampaignStats();
  const { data: geoCampaigns, isLoading: geoLoading } = useGeopoliticalCampaigns();

  const allOperations = operations ?? [];
  const allCampaigns = (campaignsRes ?? []) as Campaign[];

  // Find selected operation for detail panel
  const selectedOperation = allOperations.find(o => o.id === selectedOperationId) ?? null;

  // Filter & sort campaigns
  const filteredCampaigns = useMemo(() => {
    let result = [...allCampaigns];

    if (campaignSearch) {
      const q = campaignSearch.toLowerCase();
      result = result.filter(c => c.name.toLowerCase().includes(q));
    }

    if (attackFilter !== 'all') {
      result = result.filter(c => {
        if (!c.attack_pattern) return false;
        return c.attack_pattern.toLowerCase().includes(attackFilter);
      });
    }

    if (sortBy === 'brands') {
      result.sort((a, b) => b.brand_count - a.brand_count);
    } else if (sortBy === 'recent') {
      result.sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());
    } else {
      result.sort((a, b) => b.threat_count - a.threat_count);
    }

    return result;
  }, [allCampaigns, campaignSearch, attackFilter, sortBy]);

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
                <OperationCard
                  key={op.id}
                  operation={op}
                  isSelected={selectedOperationId === op.id}
                  onSelect={id => setSelectedOperationId(selectedOperationId === id ? null : id)}
                />
              ))}
            </div>

            {/* Operation Detail Panel */}
            {selectedOperationId && selectedOperation && (
              <div className="mt-4">
                <OperationDetailPanel operationId={selectedOperationId} operation={selectedOperation} />
              </div>
            )}

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

        {/* Filter Bar */}
        <FilterBar
          search={{
            value: campaignSearch,
            onChange: setCampaignSearch,
            placeholder: 'Search campaigns...',
          }}
          filters={ATTACK_FILTERS.map(f => ({ value: f.id, label: f.label }))}
          active={attackFilter}
          onChange={setAttackFilter}
          actions={
            <div className="flex items-center gap-1.5">
              <span
                className="font-mono text-[9px] uppercase"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Sort:
              </span>
              {SORT_OPTIONS.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSortBy(s.id)}
                  className="font-mono text-[10px] font-semibold px-2 py-0.5 rounded transition-all"
                  style={{
                    background: sortBy === s.id ? 'rgba(255,255,255,0.10)' : 'transparent',
                    color: sortBy === s.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          }
        />

        {/* Campaign Cards Grid */}
        {campaignsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : filteredCampaigns.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredCampaigns.map(campaign => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                onClick={() => navigate(`/campaigns/${campaign.id}`)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Search />}
            title="No campaigns match current filters"
            subtitle="Try adjusting your filters to see more results"
            variant="clean"
          />
        )}
      </section>
    </div>
  );
}
