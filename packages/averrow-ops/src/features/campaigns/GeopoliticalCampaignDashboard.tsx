import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { StatCard } from '@/components/ui/StatCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { severityColor, severityOpacity, threatTypeColor } from '@/lib/severityColor';
import {
  useGeopoliticalCampaign,
  useGeoCampaignStats,
  useGeoCampaignTimeline,
  useGeoCampaignBrands,
  useGeoCampaignAsns,
  useGeoCampaignAttackTypes,
  useGeoCampaignThreats,
  useGeoCampaignAssessment,
} from '@/hooks/useGeopoliticalCampaign';
import type { GeoCampaignThreat } from '@/hooks/useGeopoliticalCampaign';
import { BIMIGradeBadge } from '@/components/ui/BIMIGradeBadge';
import { AgentAttribution } from '@/components/ui/AgentAttribution';
import { ReportPanel } from '@/components/ui/ReportPanel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

// ─── Helpers ────────────────────────────────────────────────────

function parseJson<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val) as T; }
  catch { return fallback; }
}

function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr);
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatThreatType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Section Header ─────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-[9px] uppercase tracking-widest mb-3" style={{ color: 'rgba(255,255,255,0.42)' }}>
      {children}
    </h2>
  );
}

// ─── Timeline Chart (SVG area chart) ────────────────────────────

function TimelineChart({ labels, values }: { labels: string[]; values: number[] }) {
  if (labels.length === 0) {
    return <p className="text-[11px] text-gauge-gray font-mono">No timeline data available.</p>;
  }

  const maxVal = Math.max(...values, 1);
  const w = 720;
  const h = 160;
  const padX = 40;
  const padY = 20;
  const chartW = w - padX * 2;
  const chartH = h - padY * 2;

  const points = values.map((v, i) => ({
    x: padX + (i / Math.max(values.length - 1, 1)) * chartW,
    y: padY + chartH - (v / maxVal) * chartH,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${padY + chartH} L${points[0].x},${padY + chartH} Z`;

  // Y-axis tick values
  const yTicks = [0, Math.round(maxVal / 2), maxVal];

  // X-axis label sampling (show ~6 labels max)
  const step = Math.max(1, Math.floor(labels.length / 6));

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto">
      {/* Grid lines */}
      {yTicks.map(tick => {
        const y = padY + chartH - (tick / maxVal) * chartH;
        return (
          <g key={tick}>
            <line x1={padX} x2={w - padX} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" />
            <text x={padX - 6} y={y + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">
              {tick}
            </text>
          </g>
        );
      })}
      {/* Area fill */}
      <path d={areaPath} fill="url(#timeline-gradient)" opacity={0.3} />
      {/* Line */}
      <path d={linePath} fill="none" stroke="#E5A832" strokeWidth={2} />
      {/* Dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#E5A832" />
      ))}
      {/* X-axis labels */}
      {labels.map((label, i) => {
        if (i % step !== 0 && i !== labels.length - 1) return null;
        const x = padX + (i / Math.max(labels.length - 1, 1)) * chartW;
        const short = label.slice(5); // strip year prefix, show MM-DD
        return (
          <text key={i} x={x} y={h - 2} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="monospace">
            {short}
          </text>
        );
      })}
      <defs>
        <linearGradient id="timeline-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E5A832" stopOpacity={0.5} />
          <stop offset="100%" stopColor="#E5A832" stopOpacity={0} />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ─── Brands Heat Map ────────────────────────────────────────────

function BrandsHeatMap({ brands }: { brands: Array<{ name: string; threat_count: number; critical_count: number; high_count: number; sector: string | null; bimi_grade?: string | null; domain?: string | null }> }) {
  if (brands.length === 0) {
    return <p className="text-[11px] text-gauge-gray font-mono">No brand targeting data.</p>;
  }

  const maxCount = Math.max(...brands.map(b => b.threat_count), 1);
  const vulnerable = brands.filter(b =>
    b.bimi_grade && ['C', 'D', 'F'].includes(b.bimi_grade)
  );

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {brands.map(brand => {
          const opacity = severityOpacity(brand.threat_count, maxCount);
          const color = severityColor(null, brand.threat_count);
          return (
            <div
              key={brand.name}
              className="rounded-lg border border-white/10 p-3 transition-all hover:border-white/20"
              style={{ backgroundColor: `rgba(255,255,255,${opacity * 0.06})` }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-mono font-semibold text-instrument-white truncate">
                  {brand.name}
                </span>
                <div className="flex items-center gap-1.5">
                  <BIMIGradeBadge grade={(brand.bimi_grade as any) ?? null} size="sm" />
                  <span className="text-[13px] font-mono font-bold" style={{ color }}>
                    {brand.threat_count}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[9px] font-mono text-gauge-gray">
                {brand.sector && <span>{brand.sector}</span>}
                {brand.critical_count > 0 && (
                  <span className="text-[#f87171]">{brand.critical_count} crit</span>
                )}
                {brand.high_count > 0 && (
                  <span className="text-[#fb923c]">{brand.high_count} high</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {vulnerable.length > 0 && (
        <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <p className="text-red-400 text-xs font-semibold mb-1">
            Email Vulnerability
          </p>
          <p className="text-white/50 text-xs">
            {vulnerable.length} of {brands.length} targeted brands lack
            DMARC enforcement — email spoofing attacks will reach inboxes.
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {vulnerable.map(b => (
              <span key={b.name} className="text-[10px] text-red-300 font-mono">
                {b.domain ?? b.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Attack Type Bar ────────────────────────────────────────────

function AttackTypeBreakdown({ types }: { types: Array<{ threat_type: string; count: number; critical: number; high: number; medium: number; low: number }> }) {
  if (types.length === 0) {
    return <p className="text-[11px] text-gauge-gray font-mono">No attack type data.</p>;
  }

  const maxCount = Math.max(...types.map(t => t.count), 1);

  return (
    <div className="space-y-3">
      {types.map(type => {
        const pct = (type.count / maxCount) * 100;
        const color = threatTypeColor(type.threat_type);
        return (
          <div key={type.threat_type}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-mono text-instrument-white">
                {formatThreatType(type.threat_type)}
              </span>
              <span className="text-[11px] font-mono text-gauge-gray">{type.count}</span>
            </div>
            <div className="h-2 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </div>
            <div className="flex gap-3 mt-1 text-[9px] font-mono text-gauge-gray">
              {type.critical > 0 && <span className="text-[#f87171]">{type.critical} critical</span>}
              {type.high > 0 && <span className="text-[#fb923c]">{type.high} high</span>}
              {type.medium > 0 && <span className="text-[#fbbf24]">{type.medium} medium</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── ASN Cluster Table ──────────────────────────────────────────

function AsnClusterTable({ asns }: { asns: Array<{ asn: string; provider_name: string; country_code: string | null; threat_count: number; unique_ips: number; unique_domains: number; is_known_adversary: boolean }> }) {
  if (asns.length === 0) {
    return <p className="text-[11px] text-gauge-gray font-mono">No ASN data.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-gauge-gray text-left border-b border-white/10">
            <th className="pb-2 pr-4">ASN</th>
            <th className="pb-2 pr-4">Provider</th>
            <th className="pb-2 pr-4">Country</th>
            <th className="pb-2 pr-4 text-right">Threats</th>
            <th className="pb-2 pr-4 text-right">IPs</th>
            <th className="pb-2 text-right">Domains</th>
          </tr>
        </thead>
        <tbody>
          {asns.map(asn => (
            <tr key={asn.asn} className="data-row border-b border-white/5">
              <td className="py-2 pr-4">
                <span className="text-instrument-white">{asn.asn}</span>
                {asn.is_known_adversary && (
                  <span className="ml-2 rounded bg-signal-red/20 px-1.5 py-0.5 text-[8px] text-red-400 border border-signal-red/30 uppercase">
                    adversary
                  </span>
                )}
              </td>
              <td className="py-2 pr-4 text-white/70">{asn.provider_name}</td>
              <td className="py-2 pr-4 text-white/70">{countryFlag(asn.country_code)} {asn.country_code ?? '—'}</td>
              <td className="py-2 pr-4 text-right font-bold" style={{ color: severityColor(null, asn.threat_count) }}>
                {asn.threat_count}
              </td>
              <td className="py-2 pr-4 text-right text-white/60">{asn.unique_ips}</td>
              <td className="py-2 text-right text-white/60">{asn.unique_domains}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Threat Actor Cards ─────────────────────────────────────────

function ThreatActorCards({ actors }: { actors: string[] }) {
  if (actors.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {actors.map(actor => (
        <div
          key={actor}
          className="rounded-lg border border-signal-red/30 bg-signal-red/10 px-3 py-2 font-mono text-[11px] text-red-400"
        >
          {actor}
        </div>
      ))}
    </div>
  );
}

// ─── IOC Sources ────────────────────────────────────────────────

function IocSourceBadges({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {sources.map(source => (
        <span
          key={source}
          className="rounded-lg border border-wing-blue/30 bg-wing-blue/10 px-3 py-1.5 font-mono text-[10px] text-wing-blue"
        >
          {source}
        </span>
      ))}
    </div>
  );
}

// ─── Recent Threats Table ───────────────────────────────────────

function RecentThreatsTable({ threats }: { threats: GeoCampaignThreat[] }) {
  if (threats.length === 0) {
    return <p className="text-[11px] text-gauge-gray font-mono">No threats detected yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-gauge-gray text-left border-b border-white/10">
            <th className="pb-2 pr-4">Domain</th>
            <th className="pb-2 pr-4">Type</th>
            <th className="pb-2 pr-4">Severity</th>
            <th className="pb-2 pr-4">Brand</th>
            <th className="pb-2 pr-4">Origin</th>
            <th className="pb-2">Detected</th>
          </tr>
        </thead>
        <tbody>
          {threats.slice(0, 20).map(threat => (
            <tr key={threat.id} className="data-row border-b border-white/5">
              <td className="py-2 pr-4 text-instrument-white truncate max-w-[200px]">
                {threat.malicious_domain ?? '—'}
              </td>
              <td className="py-2 pr-4 text-white/70">{formatThreatType(threat.threat_type)}</td>
              <td className="py-2 pr-4">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: severityColor(threat.severity === 'critical' ? 10 : threat.severity === 'high' ? 50 : 70, undefined) }}
                  />
                  <span className="text-white/70">{threat.severity ?? 'unknown'}</span>
                </span>
              </td>
              <td className="py-2 pr-4 text-white/60">{threat.brand_name ?? '—'}</td>
              <td className="py-2 pr-4 text-white/60">{countryFlag(threat.country_code)} {threat.country_code ?? '—'}</td>
              <td className="py-2 text-white/50">{formatDate(threat.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── TTP Badges ─────────────────────────────────────────────────

function TtpBadges({ ttps }: { ttps: string[] }) {
  if (ttps.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {ttps.map(ttp => (
        <span
          key={ttp}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[11px] text-instrument-white"
        >
          {ttp}
        </span>
      ))}
    </div>
  );
}

// ─── Escalation Rules ───────────────────────────────────────────

function EscalationRules({ rules }: { rules: Record<string, string> }) {
  const entries = Object.entries(rules);
  if (entries.length === 0) return null;

  const severityStyles: Record<string, string> = {
    critical: 'text-[#f87171] bg-red-500/10 border-red-500/20',
    high: 'text-[#fb923c] bg-orange-500/10 border-orange-500/20',
    alert: 'text-[#fbbf24] bg-yellow-500/10 border-yellow-500/20',
  };

  return (
    <div className="space-y-2">
      {entries.map(([signal, action]) => (
        <div key={signal} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
          <span className="text-[11px] font-mono text-white/70">
            {signal.replace(/_/g, ' ')}
          </span>
          <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${severityStyles[action] ?? 'text-gauge-gray bg-white/5 border-white/10'}`}>
            {action}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────

export function GeopoliticalCampaignDashboard() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const { data: campaign, isLoading: campaignLoading } = useGeopoliticalCampaign(slug ?? '');
  const { data: stats } = useGeoCampaignStats(slug ?? '');
  const { data: timeline } = useGeoCampaignTimeline(slug ?? '');
  const { data: brands } = useGeoCampaignBrands(slug ?? '');
  const { data: asns } = useGeoCampaignAsns(slug ?? '');
  const { data: attackTypes } = useGeoCampaignAttackTypes(slug ?? '');
  const { data: threatsData } = useGeoCampaignThreats(slug ?? '', { limit: 20 });
  const assessmentMutation = useGeoCampaignAssessment(slug ?? '');
  const [assessment, setAssessment] = useState<string | null>(null);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const handleRunAssessment = () => {
    setAssessmentError(null);
    assessmentMutation.mutate(undefined, {
      onSuccess: (data) => {
        setAssessment(data.assessment);
        setReportOpen(true);
      },
      onError: (err) => setAssessmentError(err instanceof Error ? err.message : 'Assessment failed'),
    });
  };

  if (campaignLoading) {
    return (
      <div className="animate-fade-in p-6 space-y-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-10 w-96" />
        <div className="grid grid-cols-4 gap-3">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-6">
        <button onClick={() => navigate('/campaigns')} className="text-[11px] text-gauge-gray hover:text-instrument-white font-mono transition-colors mb-4">
          &larr; Back to Operations
        </button>
        <p className="text-gauge-gray font-mono">Geopolitical campaign not found.</p>
      </div>
    );
  }

  const threatActors = parseJson<string[]>(campaign.threat_actors, []);
  const adversaryCountries = parseJson<string[]>(campaign.adversary_countries, []);
  const targetCountries = parseJson<string[]>(campaign.target_countries, []);
  const ttps = parseJson<string[]>(campaign.ttps, []);
  const iocSources = parseJson<string[]>(campaign.ioc_sources, []);
  const escalationRules = parseJson<Record<string, string>>(campaign.escalation_rules, {});
  const adversaryAsns = parseJson<string[]>(campaign.adversary_asns, []);

  const daysActive = daysSince(campaign.start_date);

  return (
    <div className="animate-fade-in p-6 space-y-6">
      {/* Back nav */}
      <button
        onClick={() => navigate('/campaigns')}
        className="text-[11px] text-gauge-gray hover:text-instrument-white font-mono transition-colors"
      >
        &larr; Back to Operations
      </button>

      {/* Campaign Header */}
      <div className="rounded-xl border border-signal-red/30 bg-signal-red/5 p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase ${
                campaign.status === 'active'
                  ? 'bg-signal-red/20 text-red-400 border-signal-red/30 animate-pulse'
                  : campaign.status === 'dormant'
                    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                    : 'bg-white/5 text-gauge-gray border-white/10'
              }`}>
                {campaign.status}
              </span>
              <span className="font-mono text-[10px] text-gauge-gray uppercase tracking-widest">
                Geopolitical Campaign
              </span>
            </div>
            <h1 className="text-xl font-mono font-bold text-instrument-white mb-1">
              {campaign.name}
            </h1>
            {campaign.description && (
              <p className="text-[12px] text-white/60 max-w-3xl leading-relaxed mt-2">
                {campaign.description}
              </p>
            )}
          </div>
          <div className="text-right">
            <div className="text-[10px] text-gauge-gray font-mono">Active since</div>
            <div className="text-[14px] font-mono font-bold" style={{ color: 'var(--amber)' }}>
              {formatDate(campaign.start_date)}
            </div>
            <div className="text-[10px] text-gauge-gray font-mono mt-1">{daysActive} days</div>
          </div>
        </div>

        {/* Adversary / Target flags */}
        <div className="flex gap-6 mt-4">
          <div>
            <span className="text-[9px] font-mono text-gauge-gray uppercase tracking-widest">Adversary</span>
            <div className="flex gap-1.5 mt-1">
              {adversaryCountries.map(c => (
                <span key={c} className="text-lg" title={c}>{countryFlag(c)}</span>
              ))}
            </div>
          </div>
          <div>
            <span className="text-[9px] font-mono text-gauge-gray uppercase tracking-widest">Targets</span>
            <div className="flex gap-1.5 mt-1">
              {targetCountries.map(c => (
                <span key={c} className="text-lg" title={c}>{countryFlag(c)}</span>
              ))}
            </div>
          </div>
          <div>
            <span className="text-[9px] font-mono text-gauge-gray uppercase tracking-widest">Known ASNs</span>
            <div className="flex gap-1.5 mt-1">
              {adversaryAsns.map(a => (
                <span key={a} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[9px] text-gauge-gray border border-white/10">
                  {a}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* AI Intelligence Assessment */}
      <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
        <div className="flex justify-between items-center mb-3">
          <SectionTitle>AI Intelligence Assessment</SectionTitle>
          <AgentAttribution agent="ASTRA" />
          <button
            onClick={handleRunAssessment}
            disabled={assessmentMutation.isPending}
            className="rounded-lg border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40"
            style={{ borderColor: 'rgba(229,168,50,0.30)', background: 'rgba(229,168,50,0.10)', color: 'var(--amber)' }}
          >
            {assessmentMutation.isPending ? 'Analyzing...' : assessment ? 'Regenerate' : 'Run Assessment'}
          </button>
        </div>
        {assessment ? (
          <div className="flex items-center justify-between gap-3">
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              AI Intelligence Assessment available
            </div>
            <Button variant="secondary" size="sm" onClick={() => setReportOpen(true)}>
              View Report →
            </Button>
          </div>
        ) : assessmentError ? (
          <p className="text-[11px] text-red-400 font-mono">{assessmentError}</p>
        ) : (
          <p className="text-[11px] text-gauge-gray font-mono">
            Generate an AI-powered intelligence assessment of this campaign using current platform threat data.
          </p>
        )}
      </div>

      {/* Report Panel */}
      <ReportPanel
        isOpen={reportOpen}
        onClose={() => setReportOpen(false)}
        title={campaign.name}
        subtitle="AI Intelligence Assessment"
        badge={<Badge status="active" label="ASTRA" size="xs" />}
        content={assessment ?? ''}
        meta={
          <>
            <span>Generated by ASTRA</span>
            <span>•</span>
            <span>{new Date().toLocaleDateString()}</span>
          </>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRunAssessment}
            disabled={assessmentMutation.isPending}
          >
            {assessmentMutation.isPending ? 'Regenerating...' : 'Regenerate Assessment'}
          </Button>
        }
      />

      {/* Live Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          title="TOTAL THREATS"
          metric={
            <span className="text-[32px] font-bold leading-none" style={{ color: severityColor(null, stats?.total_threats ?? 0) }}>
              {stats?.total_threats ?? 0}
            </span>
          }
          metricLabel="campaign total"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[#f87171]" />
              <span className="text-[11px] text-white/60">Critical</span>
              <span className="text-[11px] font-mono text-instrument-white">{stats?.critical_count ?? 0}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[#fb923c]" />
              <span className="text-[11px] text-white/60">High</span>
              <span className="text-[11px] font-mono text-instrument-white">{stats?.high_count ?? 0}</span>
            </div>
          </div>
        </StatCard>
        <StatCard
          title="LAST 24 HOURS"
          metric={
            <span className="text-[32px] font-bold leading-none" style={{ color: 'var(--amber)' }}>
              {stats?.threats_24h ?? 0}
            </span>
          }
          metricLabel="new threats"
        >
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-afterburner" />
            <span className="text-[11px] text-white/60">7-day</span>
            <span className="text-[11px] font-mono text-instrument-white">{stats?.threats_7d ?? 0}</span>
          </div>
        </StatCard>
        <StatCard
          title="BRANDS TARGETED"
          metric={
            <span className="text-[32px] font-bold leading-none text-wing-blue">
              {stats?.brands_targeted ?? 0}
            </span>
          }
          metricLabel="brands"
        >
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-wing-blue" />
            <span className="text-[11px] text-white/60">Under attack</span>
          </div>
        </StatCard>
        <StatCard
          title="INFRASTRUCTURE"
          metric={
            <span className="text-[32px] font-bold leading-none text-[#fbbf24]">
              {stats?.unique_ips ?? 0}
            </span>
          }
          metricLabel="unique IPs"
        >
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-[#fbbf24]" />
            <span className="text-[11px] text-white/60">Domains</span>
            <span className="text-[11px] font-mono text-instrument-white">{stats?.unique_domains ?? 0}</span>
          </div>
        </StatCard>
      </div>

      {/* Timeline */}
      <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
        <SectionTitle>Attack Timeline</SectionTitle>
        {timeline ? (
          <TimelineChart labels={timeline.labels} values={timeline.values} />
        ) : (
          <Skeleton className="h-40 w-full rounded" />
        )}
      </div>

      {/* Two-column: Brands + Attack Types */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Targeted Brands Heat Map */}
        <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
          <SectionTitle>Targeted Brands Heat Map</SectionTitle>
          {brands ? (
            <BrandsHeatMap brands={brands} />
          ) : (
            <Skeleton className="h-40 w-full rounded" />
          )}
        </div>

        {/* Attack Type Breakdown */}
        <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
          <SectionTitle>Attack Type Breakdown</SectionTitle>
          {attackTypes ? (
            <AttackTypeBreakdown types={attackTypes} />
          ) : (
            <Skeleton className="h-40 w-full rounded" />
          )}
        </div>
      </div>

      {/* ASN Cluster Analysis */}
      <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
        <SectionTitle>ASN Cluster Analysis</SectionTitle>
        {asns ? (
          <AsnClusterTable asns={asns} />
        ) : (
          <Skeleton className="h-40 w-full rounded" />
        )}
      </div>

      {/* Two-column: Threat Actors + IOC Sources */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Threat Actor Attribution */}
        <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
          <SectionTitle>Threat Actor Attribution</SectionTitle>
          <ThreatActorCards actors={threatActors} />
          {ttps.length > 0 && (
            <div className="mt-4">
              <SectionTitle>MITRE ATT&CK TTPs</SectionTitle>
              <TtpBadges ttps={ttps} />
            </div>
          )}
        </div>

        {/* IOC Correlation Sources */}
        <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
          <SectionTitle>IOC Correlation Sources</SectionTitle>
          <IocSourceBadges sources={iocSources} />
          {Object.keys(escalationRules).length > 0 && (
            <div className="mt-4">
              <SectionTitle>Escalation Rules</SectionTitle>
              <EscalationRules rules={escalationRules} />
            </div>
          )}
        </div>
      </div>

      {/* Recent Threats */}
      <div className="rounded-xl border border-white/10 bg-instrument-panel p-4">
        <div className="flex items-center justify-between mb-3">
          <SectionTitle>Recent Threats ({threatsData?.total ?? 0})</SectionTitle>
        </div>
        {threatsData ? (
          <RecentThreatsTable threats={threatsData.threats} />
        ) : (
          <Skeleton className="h-40 w-full rounded" />
        )}
      </div>
    </div>
  );
}
