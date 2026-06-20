// CampaignDetail — full drill-down for a Strategist-clustered campaign.
//
// Replaces the prior 70-line stub ("Detail view coming soon"). Pulls
// from the 5 backend endpoints the API already exposes:
//   /api/campaigns/:id              — overview + breakdown
//   /api/campaigns/:id/threats      — recent threat rows
//   /api/campaigns/:id/infrastructure — IPs / domains / providers
//   /api/campaigns/:id/brands       — brand impact ranking
//   /api/campaigns/:id/timeline     — attack volume over time
//
// Visual shape matches the ThreatActors / Providers detail pattern:
// EntityCard shell with accent stripe, metric tiles, then sectioned
// PanelHeader rows for Threats / Infrastructure / Brands / Timeline.
//
// The route is what every campaign notification deep-links into
// (Strategist creates notifications with `link: /campaigns/:id`).
// This page is the drill-down those clicks land on.
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import {
  Badge,
  Card,
  EntityCard,
  MetricTile,
  SeverityPill,
} from '@/design-system/components';
import { Skeleton } from '@/components/ui/Skeleton';
import { ThreatAreaChart } from '@/components/ui/ThreatAreaChart';
import {
  useCampaignDetail,
  useCampaignTimeline,
  useCampaignThreats,
  useCampaignInfrastructure,
  useCampaignBrands,
} from '@/hooks/useCampaigns';

// ─── Helpers ──────────────────────────────────────────────────

function formatDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function countryFlag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

function severityAccent(severity: string | null | undefined, threatCount: number): string {
  const s = (severity ?? '').toLowerCase();
  if (s === 'critical') return 'var(--sev-critical)';
  if (s === 'high')     return 'var(--sev-high)';
  if (s === 'medium')   return 'var(--amber)';
  if (s === 'low')      return 'var(--sev-low)';
  if (threatCount > 3000) return 'var(--sev-critical)';
  if (threatCount > 1000) return 'var(--sev-high)';
  if (threatCount > 300)  return 'var(--amber)';
  return 'var(--text-muted)';
}

function parseAttackType(pattern: string | null | undefined): {
  type: string | null;
  ip: string | null;
  threatTypes: string[];
} {
  if (!pattern) return { type: null, ip: null, threatTypes: [] };
  try {
    const parsed = JSON.parse(pattern) as Record<string, unknown>;
    const type = (parsed['attack_type'] ?? parsed['type']) as string | undefined;
    const ip = parsed['ip'] as string | undefined;
    const ttRaw = parsed['threat_types'];
    const threatTypes = typeof ttRaw === 'string'
      ? ttRaw.split(',').map(s => s.trim()).filter(Boolean)
      : Array.isArray(ttRaw) ? ttRaw.map(String) : [];
    return { type: type ?? null, ip: ip ?? null, threatTypes };
  } catch {
    return { type: pattern, ip: null, threatTypes: [] };
  }
}

// ─── Subcomponents ────────────────────────────────────────────

function PanelHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="pt-1">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-mono font-bold uppercase tracking-[0.18em]" style={{ color: 'var(--text-secondary)' }}>
          {title}
        </h2>
        {subtitle && (
          <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{subtitle}</span>
        )}
      </div>
      <div className="mt-1.5 h-px bg-gradient-to-r from-white/[0.10] via-white/[0.04] to-transparent" />
    </div>
  );
}

function CampaignNotFound({ onBack }: { onBack: () => void }) {
  return (
    <div className="animate-fade-in space-y-4">
      <button onClick={onBack} className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
        <ArrowLeft size={12} /> Back to Operations
      </button>
      <Card hover={false}>
        <div className="py-8 text-center">
          <div className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            Campaign not found
          </div>
          <div className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            The campaign may have been merged, dissolved, or attributed to a threat actor.
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────

export function CampaignDetail() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();

  const id = campaignId ?? '';
  const { data: campaign, isLoading: campaignLoading } = useCampaignDetail(id);
  const { data: timeline, isLoading: timelineLoading } = useCampaignTimeline(id, '30d');
  const { data: threats, isLoading: threatsLoading } = useCampaignThreats(id, 25);
  const { data: infrastructure, isLoading: infraLoading } = useCampaignInfrastructure(id);
  const { data: brandImpact, isLoading: brandsLoading } = useCampaignBrands(id);

  const backToList = () => navigate('/campaigns');

  if (campaignLoading) {
    return (
      <div className="animate-fade-in space-y-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (!campaign) {
    return <CampaignNotFound onBack={backToList} />;
  }

  const { type: attackType, ip: clusterIp, threatTypes } = parseAttackType(campaign.attack_pattern);
  const accent = severityAccent(campaign.severity, campaign.threat_count);
  const status = (campaign.status ?? 'active').toLowerCase();

  const chartData = timeline
    ? timeline.labels.map((label, i) => ({
        label: label.length >= 10 ? label.slice(5, 10) : label,
        value: timeline.values[i] ?? 0,
      }))
    : [];

  return (
    <div className="animate-fade-in space-y-5 pb-12">
      {/* ─── Back link ─────────────────────────────────────── */}
      <button
        onClick={backToList}
        className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors hover:text-[var(--amber)]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <ArrowLeft size={12} /> Back to Operations
      </button>

      {/* ─── Header card (severity-accented EntityCard) ───── */}
      <EntityCard accent={accent} padding="18px 22px">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="font-mono text-[9px] font-bold uppercase tracking-[0.18em]"
                style={{ color: 'var(--text-muted)' }}
              >
                Campaign
              </span>
              <Badge
                status={status === 'active' ? 'active' : 'inactive'}
                label={status.charAt(0).toUpperCase() + status.slice(1)}
                size="xs"
                pulse={status === 'active'}
              />
              {attackType && (
                <span
                  className="font-mono text-[9px] font-bold uppercase tracking-[0.10em] px-2 py-0.5 rounded-full"
                  style={{
                    background: `${accent}15`,
                    border: `1px solid ${accent}40`,
                    color: accent,
                  }}
                >
                  {attackType.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <h1
              className="font-display text-2xl font-bold mb-1"
              style={{ color: 'var(--text-primary)', letterSpacing: '-0.2px' }}
            >
              {campaign.name}
            </h1>
            <div className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
              First seen {formatDate(campaign.first_seen)} {'·'} Last seen {formatDate(campaign.last_seen)}
              {clusterIp && (
                <> {'·'} Origin IP <span style={{ color: 'var(--text-tertiary)' }}>{clusterIp}</span></>
              )}
            </div>
          </div>
        </div>

        {/* Metric tiles row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
          <MetricTile label="Threats" value={campaign.threat_count} color={accent} glow />
          <MetricTile label="Brands" value={campaign.brand_count} color="var(--amber)" glow />
          <MetricTile label="Providers" value={campaign.provider_count} color="var(--blue)" glow />
          <MetricTile label="Domains" value={campaign.domain_count} color="var(--text-secondary)" />
        </div>

        {/* Threat-type pills (when present) */}
        {threatTypes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {threatTypes.map(t => (
              <span
                key={t}
                className="font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                style={{
                  background: 'var(--border-base)',
                  border: '1px solid var(--border-base)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {t.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}
      </EntityCard>

      {/* ─── Attack timeline ──────────────────────────────── */}
      <Card hover={false} style={{ padding: '16px 18px' }}>
        <PanelHeader title="Attack timeline" subtitle="last 30 days" />
        <div className="mt-3">
          {timelineLoading ? (
            <Skeleton className="h-[220px] w-full rounded-lg" />
          ) : chartData.length > 0 ? (
            <ThreatAreaChart
              data={chartData}
              height={220}
              color={accent}
              label="Threats"
              showYAxis
            />
          ) : (
            <div
              className="h-[180px] flex items-center justify-center font-mono text-[11px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              No timeline data
            </div>
          )}
        </div>
      </Card>

      {/* ─── Brand impact + Infrastructure (side-by-side) ──── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Brand impact */}
        <Card hover={false} style={{ padding: '16px 18px' }}>
          <PanelHeader title="Brands targeted" subtitle={`${brandImpact?.length ?? 0} affected`} />
          <div className="mt-3 space-y-1">
            {brandsLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded" />)
            ) : (brandImpact ?? []).length === 0 ? (
              <div className="py-4 text-center font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                No specific brand attribution
              </div>
            ) : (
              (brandImpact ?? []).slice(0, 8).map(b => (
                <Link
                  key={b.id}
                  to={`/brands/${b.id}`}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 rounded transition-colors hover:bg-white/[0.04]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{b.name}</div>
                    {b.sector && (
                      <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                        {b.sector}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold" style={{ color: accent }}>
                      {b.threat_count.toLocaleString()}
                    </span>
                    <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
                  </div>
                </Link>
              ))
            )}
          </div>
        </Card>

        {/* Hosting providers */}
        <Card hover={false} style={{ padding: '16px 18px' }}>
          <PanelHeader title="Hosting providers" subtitle={`${infrastructure?.providers.length ?? 0} in use`} />
          <div className="mt-3 space-y-1">
            {infraLoading ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded" />)
            ) : (infrastructure?.providers ?? []).length === 0 ? (
              <div className="py-4 text-center font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                No provider attribution
              </div>
            ) : (
              (infrastructure?.providers ?? []).slice(0, 8).map(p => (
                <Link
                  key={p.provider_id}
                  to={`/providers/${p.provider_id}`}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 rounded transition-colors hover:bg-white/[0.04]"
                >
                  <div className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--text-primary)' }}>
                    {p.provider_name}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold" style={{ color: 'var(--blue)' }}>
                      {p.threat_count.toLocaleString()}
                    </span>
                    <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
                  </div>
                </Link>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* ─── Top IPs ──────────────────────────────────────── */}
      <Card hover={false} style={{ padding: '16px 18px' }}>
        <PanelHeader title="Top IPs" subtitle={`${infrastructure?.ips.length ?? 0} unique`} />
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {infraLoading ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded" />)
          ) : (infrastructure?.ips ?? []).length === 0 ? (
            <div className="col-span-full py-4 text-center font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
              No IP intelligence
            </div>
          ) : (
            (infrastructure?.ips ?? []).slice(0, 16).map(ip => (
              <div
                key={ip.ip_address}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded"
                style={{ background: 'var(--border-base)', border: '1px solid var(--border-base)' }}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {ip.country_code && <span className="text-base">{countryFlag(ip.country_code)}</span>}
                  <span className="font-mono text-xs truncate" style={{ color: 'var(--text-primary)' }}>
                    {ip.ip_address}
                  </span>
                </div>
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {ip.domain_count} dom
                </span>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* ─── Recent threats ──────────────────────────────── */}
      <Card hover={false} style={{ padding: '16px 18px' }}>
        <PanelHeader title="Recent threats" subtitle={`showing ${threats?.length ?? 0}`} />
        <div className="mt-3 divide-y divide-white/[0.04]">
          {threatsLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)
          ) : (threats ?? []).length === 0 ? (
            <div className="py-4 text-center font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
              No recent threat rows
            </div>
          ) : (
            (threats ?? []).slice(0, 25).map(t => (
              <Link
                key={t.id}
                to={`/threats?q=${encodeURIComponent(t.malicious_domain || t.malicious_url || t.ip_address || t.id)}`}
                className="flex items-center gap-3 px-1 py-2 transition-colors hover:bg-white/[0.03]"
              >
                <SeverityPill severity={t.severity} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                    {t.malicious_domain || t.malicious_url || t.ip_address || t.id}
                  </div>
                  <div className="font-mono text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {t.threat_type.replace(/_/g, ' ')}
                    {t.brand_name && (<> {'·'} <span style={{ color: 'var(--text-tertiary)' }}>{t.brand_name}</span></>)}
                    {t.country_code && (<> {'·'} {countryFlag(t.country_code)}</>)}
                  </div>
                </div>
                <div className="font-mono text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                  {formatDate(t.first_seen)}
                </div>
                <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
              </Link>
            ))
          )}
        </div>
      </Card>

    </div>
  );
}
