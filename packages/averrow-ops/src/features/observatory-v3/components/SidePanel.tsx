/**
 * Observatory v3 Side Panel — situational intelligence for the current map view.
 *
 * Reworked (2026-06) so the panel is pertinent + logical:
 *   - Everything that can respect the map's period does, and section labels are
 *     dynamic to the selected period (no more hard-coded "7d" that lies).
 *   - Leads with a situational SUMMARY (threats mapped · countries · campaigns +
 *     severity split) so you know what you're looking at.
 *   - Adds TOP THREAT ORIGINS (where attacks come from) — the key ranking a
 *     threat map should have, derived from the same geo nodes the globe draws.
 *   - Every entity row pivots into its detail page.
 *
 * Widgets:
 *   0. Summary (period)            — stats + severity bar
 *   1. Top Threat Origins (period) — countries by threat volume
 *   2. Top Targeted Brands (period)
 *   3. Hosting Providers (7d trend — structurally fixed)
 *   4. Active Operations
 *   5. Geopolitical Campaigns (30d)
 *   6. Agent Intelligence         — v2 parity (observatory-v2 retirement)
 *   7. Live Feed                  — v2 parity (observatory-v2 retirement)
 */

import { memo, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useObservatoryThreats, useObservatoryStats } from '@/hooks/useObservatory';
import { useBrands } from '@/hooks/useBrands';
import { useDashboardProviders } from '@/hooks/useProviders';
import type { DashboardProvider } from '@/hooks/useProviders';
import { useOperations } from '@/hooks/useOperations';
import { useGeopoliticalCampaigns } from '@/hooks/useGeopoliticalCampaign';
import { useAgents } from '@/hooks/useAgents';
import { DimensionalAvatar } from '@/components/ui/DimensionalAvatar';
import { Badge } from '@/components/ui/Badge';
import { AgentAttribution } from '@/components/ui/AgentAttribution';
import { relativeTime } from '@/lib/time';

// ─── Helpers ────────────────────────────────────────────────
function fmtPeriod(p: string): string {
  return (p || '7d').toUpperCase();
}

function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return '🏳️';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="px-4 py-2 flex items-center gap-2">
      <div className="h-px flex-1 bg-white/[0.08]" />
      <span className="text-[9px] font-mono tracking-[0.2em] uppercase shrink-0" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <div className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent mx-4 my-2" />;
}

// ─── Summary header ─────────────────────────────────────────
const SummaryHeader = memo(function SummaryHeader({ period }: { period: string }) {
  const { data: stats, error: statsError, refetch: refetchStats } = useObservatoryStats({ period });
  const { data: nodesData, error: nodesError, refetch: refetchNodes } = useObservatoryThreats({ period });
  const nodes = nodesData ?? [];
  const summaryError = statsError || nodesError;

  const sev = nodes.reduce(
    (a, n) => ({
      critical: a.critical + (n.critical || 0),
      high: a.high + (n.high || 0),
      medium: a.medium + (n.medium || 0),
      low: a.low + (n.low || 0),
    }),
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
  const sevTotal = sev.critical + sev.high + sev.medium + sev.low;

  const segs: Array<{ k: keyof typeof sev; color: string }> = [
    { k: 'critical', color: 'var(--sev-critical)' },
    { k: 'high', color: 'var(--sev-high)' },
    { k: 'medium', color: 'var(--sev-medium)' },
    { k: 'low', color: 'var(--sev-low)' },
  ];

  const Stat = ({ label, value }: { label: string; value: number | null | undefined }) => (
    <div>
      <div className="text-sm font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
        {value != null ? value.toLocaleString() : '—'}
      </div>
      <div className="text-[8px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );

  return (
    <div className="px-4 pt-3 pb-1">
      {summaryError && (
        <div
          className="flex items-center justify-between gap-2 mb-2 px-2 py-1.5 rounded"
          style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)' }}
        >
          <span className="text-[9px] font-mono" style={{ color: 'var(--sev-critical-text)' }}>
            Summary failed to load
          </span>
          <button
            onClick={() => { if (statsError) refetchStats(); if (nodesError) refetchNodes(); }}
            className="ds-focusable text-[9px] font-mono font-bold uppercase tracking-wide shrink-0"
            style={{ color: 'var(--sev-critical-text)', background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }}
          >
            Retry
          </button>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 mb-2">
        <Stat label="Threats" value={stats?.threats_mapped} />
        <Stat label="Countries" value={stats?.countries} />
        <Stat label="Campaigns" value={stats?.active_campaigns} />
      </div>
      {sevTotal > 0 && (
        <>
          <div className="flex h-1.5 rounded-full overflow-hidden mb-1">
            {segs.map(s => sev[s.k] > 0 && (
              <div key={s.k} style={{ width: `${(sev[s.k] / sevTotal) * 100}%`, background: s.color }} />
            ))}
          </div>
          <div className="flex items-center gap-3 text-[8px] font-mono" style={{ color: 'var(--text-muted)' }}>
            {segs.map(s => sev[s.k] > 0 && (
              <span key={s.k} className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                {sev[s.k].toLocaleString()}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
});

// ─── Top Threat Origins ─────────────────────────────────────
const TopOriginsWidget = memo(function TopOriginsWidget({ period }: { period: string }) {
  const { data: nodesData } = useObservatoryThreats({ period });
  const nodes = nodesData ?? [];

  const byCountry = new Map<string, number>();
  for (const n of nodes) {
    if (n.country_code) byCountry.set(n.country_code, (byCountry.get(n.country_code) ?? 0) + n.threat_count);
  }
  const top = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = top[0]?.[1] ?? 1;

  return (
    <div className="px-4 pb-2">
      {top.length === 0 ? (
        <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>No geolocated threats in this period</div>
      ) : (
        top.map(([code, count]) => (
          <div key={code} className="flex items-center gap-2.5 py-1">
            <span className="text-sm shrink-0">{countryFlag(code)}</span>
            <span className="text-xs font-mono shrink-0 w-6" style={{ color: 'var(--text-secondary)' }}>{code}</span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <div className="h-full rounded-full" style={{ width: `${(count / max) * 100}%`, background: 'var(--amber)' }} />
            </div>
            <span className="text-xs font-mono font-bold tabular-nums shrink-0" style={{ color: 'var(--text-primary)' }}>
              {count.toLocaleString()}
            </span>
          </div>
        ))
      )}
    </div>
  );
});

// ─── Provider row ───────────────────────────────────────────
function ProviderRow({ p, direction }: { p: DashboardProvider; direction: 'worsening' | 'improving' }) {
  const navigate = useNavigate();
  const trendPct = p.trend_7d_pct;
  const trendColor = direction === 'worsening' ? 'var(--sev-critical)' : 'var(--sev-info)';
  const arrow = direction === 'worsening' ? '↑' : '↓';

  return (
    <div
      className="flex items-center justify-between py-1.5 cursor-pointer hover:bg-white/[0.03] rounded -mx-1 px-1 transition-colors"
      onClick={() => navigate(`/providers?focus=${encodeURIComponent(p.provider_id)}`)}
    >
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</div>
        {p.asn && (
          <div className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>{p.asn}</div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        <span className="text-xs font-mono font-bold" style={{ color: 'var(--text-secondary)' }}>
          {p.threat_count.toLocaleString()}
        </span>
        {trendPct != null && (
          <span className="text-[10px] font-mono font-bold" style={{ color: trendColor }}>
            {arrow} {Math.abs(Math.round(trendPct))}%
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Top Targeted Brands ────────────────────────────────────
const TopBrandsWidget = memo(function TopBrandsWidget({ period }: { period: string }) {
  const navigate = useNavigate();
  const { data: brands = [] } = useBrands({ view: 'top', limit: 8, timeRange: period });

  return (
    <div className="px-4 pb-2">
      {brands.length === 0 ? (
        <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>No targeted brands in this period</div>
      ) : (
        brands.map((brand) => (
          <div
            key={brand.id}
            className="flex items-center gap-2.5 py-1.5 cursor-pointer hover:bg-white/[0.03] rounded -mx-1 px-1 transition-colors"
            onClick={() => navigate(`/brands/${brand.id}`)}
          >
            <DimensionalAvatar
              name={brand.name}
              color="var(--amber)"
              dimColor="var(--amber-dim)"
              faviconUrl={brand.canonical_domain ? `https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=32` : undefined}
              size={24}
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{brand.name}</div>
              <div className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>{brand.canonical_domain}</div>
            </div>
            <div className="flex-shrink-0">
              <span className="text-xs font-mono font-bold" style={{ color: 'var(--sev-critical)' }}>
                {(brand.threat_count ?? 0).toLocaleString()}
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
});

// ─── Providers Worsening / Improving (7d trend) ─────────────
const ProvidersWidget = memo(function ProvidersWidget() {
  const { data: worsening = [] } = useDashboardProviders('worst', 3);
  const { data: improving = [] } = useDashboardProviders('improving', 3);

  return (
    <div className="px-4 pb-2">
      <div className="mb-2">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--sev-critical)' }} />
          <span className="text-[8px] font-mono tracking-wider uppercase" style={{ color: 'var(--sev-critical)' }}>Worsening</span>
        </div>
        {worsening.length === 0 ? (
          <div className="text-[10px] font-mono py-1" style={{ color: 'var(--text-muted)' }}>No worsening providers</div>
        ) : (
          worsening.map((p) => <ProviderRow key={p.provider_id} p={p} direction="worsening" />)
        )}
      </div>
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--sev-info)' }} />
          <span className="text-[8px] font-mono tracking-wider uppercase" style={{ color: 'var(--sev-info)' }}>Improving</span>
        </div>
        {improving.length === 0 ? (
          <div className="text-[10px] font-mono py-1" style={{ color: 'var(--text-muted)' }}>No improving providers</div>
        ) : (
          improving.map((p) => <ProviderRow key={p.provider_id} p={p} direction="improving" />)
        )}
      </div>
    </div>
  );
});

// ─── Active Operations ──────────────────────────────────────
const OperationsWidget = memo(function OperationsWidget() {
  const navigate = useNavigate();
  const { data: operations = [] } = useOperations({ status: 'active', limit: 4 });

  return (
    <div className="px-4 pb-2">
      {operations.length === 0 ? (
        <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>No active operations</div>
      ) : (
        operations.map((op) => {
          const countries = op.countries ? JSON.parse(op.countries) as string[] : [];
          const asns = parseJsonArray(op.asns);
          const isAccelerating = op.agent_notes?.includes('ACCELERATING');
          return (
            <div
              key={op.id}
              className="py-2 cursor-pointer hover:bg-white/[0.03] rounded -mx-1 px-1 transition-colors"
              onClick={() => navigate(`/campaigns/${op.id}`)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {op.cluster_name || 'Unnamed Cluster'}
                </span>
                {isAccelerating && <Badge severity="high" label="ACCEL" size="xs" />}
              </div>
              <div className="flex items-center gap-3 text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>
                <span>{op.threat_count.toLocaleString()} threats</span>
                {countries.length > 0 && <span>{countries.slice(0, 3).join(', ')}</span>}
              </div>
              {(asns.length > 0 || op.confidence_score != null) && (
                <div className="flex items-center gap-3 text-[9px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {asns.length > 0 && (
                    <span className="truncate">{asns.slice(0, 2).join(', ')}</span>
                  )}
                  {op.confidence_score != null && (
                    <span className="shrink-0 ml-auto tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {op.confidence_score}% conf
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
});

// ─── Geopolitical Campaigns ─────────────────────────────────
const GeoCampaignsWidget = memo(function GeoCampaignsWidget() {
  const navigate = useNavigate();
  const { data: campaigns = [] } = useGeopoliticalCampaigns('active');

  const recent = campaigns.filter(c => {
    if (!c.start_date) return true;
    const start = new Date(c.start_date).getTime();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return start > thirtyDaysAgo || !c.end_date;
  });

  return (
    <div className="px-4 pb-2">
      {recent.length === 0 ? (
        <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>No active campaigns</div>
      ) : (
        recent.map((c) => {
          const adversary = c.adversary_countries ? JSON.parse(c.adversary_countries) as string[] : [];
          const targets = c.target_sectors ? JSON.parse(c.target_sectors) as string[] : [];
          return (
            <div
              key={c.id}
              className="py-2 cursor-pointer hover:bg-white/[0.03] rounded -mx-1 px-1 transition-colors"
              onClick={() => navigate(`/campaigns/geo/${c.name.toLowerCase().replace(/\s+/g, '-')}`)}
            >
              <div className="flex items-center gap-2 mb-1">
                <Badge status="active" label={c.status} size="xs" pulse />
                <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {c.name}
                </span>
              </div>
              <div className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {adversary.length > 0 && <span>{adversary.join(', ')}</span>}
                {targets.length > 0 && <span> {'→'} {targets.slice(0, 2).join(', ')}</span>}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
});

// ─── Agent Intelligence (v2 parity) ─────────────────────────
const AgentIntelWidget = memo(function AgentIntelWidget() {
  const { data: agents, error, refetch } = useAgents();
  const recentOutputs = useMemo(
    () =>
      (agents ?? [])
        .filter(a => a.last_output_at)
        .sort((a, b) => new Date(b.last_output_at!).getTime() - new Date(a.last_output_at!).getTime())
        .slice(0, 5),
    [agents],
  );

  return (
    <div className="px-4 pb-2">
      <AgentAttribution agent="Observer + Sentinel" />
      {error ? (
        <div
          className="flex items-center justify-between gap-2 mt-2 px-2 py-1.5 rounded"
          style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)' }}
        >
          <span className="text-[9px] font-mono" style={{ color: 'var(--sev-critical-text)' }}>
            Agent feed failed to load
          </span>
          <button
            onClick={() => refetch()}
            className="ds-focusable text-[9px] font-mono font-bold uppercase tracking-wide shrink-0"
            style={{ color: 'var(--sev-critical-text)', background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }}
          >
            Retry
          </button>
        </div>
      ) : recentOutputs.length === 0 ? (
        <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>No recent agent output</div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {recentOutputs.map(agent => (
            <div key={agent.agent_id} className="flex items-center gap-2 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: agent.color }} />
              <span className="text-[10px] font-mono font-bold uppercase truncate flex-1" style={{ color: agent.color }}>
                {agent.display_name}
              </span>
              <span className="text-[9px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                {agent.outputs_24h} out &middot; {relativeTime(agent.last_output_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ─── Live Feed (v2 parity) ───────────────────────────────────
interface LiveThreatEntry {
  id: string;
  threat_type: string;
  severity: string | null;
  country_code: string | null;
  created_at: string;
  malicious_domain: string | null;
}

const LIVE_SEVERITY_COLOR: Record<string, string> = {
  critical: 'var(--sev-critical)',
  high: 'var(--sev-high)',
  medium: 'var(--sev-medium)',
  low: 'var(--sev-low)',
};

const LiveFeedWidget = memo(function LiveFeedWidget() {
  // NOTE: the SidePanel doesn't currently receive the map's `source` filter
  // (SidePanelProps only carries `period` + `visible`, and ObservatoryV3.tsx
  // is owned by a sibling change) — this defaults to `all`, matching the
  // current app state where source selection isn't wired to the panel yet.
  const { data: entries = [], error, refetch } = useQuery({
    queryKey: ['observatory-live-feed'],
    queryFn: async () => {
      const res = await api.get<LiveThreatEntry[]>('/api/observatory/live?limit=8');
      if (!res.success) throw new Error(res.error || 'Live feed failed to load');
      return res.data ?? [];
    },
    refetchInterval: 15_000,
  });

  return (
    <div className="px-4 pb-2">
      {error ? (
        <div
          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded"
          style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)' }}
        >
          <span className="text-[9px] font-mono" style={{ color: 'var(--sev-critical-text)' }}>
            Live feed failed to load
          </span>
          <button
            onClick={() => refetch()}
            className="ds-focusable text-[9px] font-mono font-bold uppercase tracking-wide shrink-0"
            style={{ color: 'var(--sev-critical-text)', background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }}
          >
            Retry
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>Waiting for threats...</div>
      ) : (
        <div className="space-y-1">
          {entries.slice(0, 8).map(entry => (
            <div key={entry.id} className="flex items-center gap-2 py-0.5">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: LIVE_SEVERITY_COLOR[entry.severity?.toLowerCase() ?? ''] ?? 'var(--sev-low)' }}
                aria-label={entry.severity ?? 'unknown severity'}
                title={entry.severity ?? undefined}
              />
              <span className="text-[10px] font-mono truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                {entry.threat_type?.replace(/_/g, ' ')}
              </span>
              {entry.country_code && (
                <span className="text-[9px] font-mono shrink-0" style={{ color: 'var(--text-secondary)' }}>{entry.country_code}</span>
              )}
              <span className="text-[9px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                {relativeTime(entry.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ─── Main SidePanel ─────────────────────────────────────────
interface SidePanelProps {
  period: string;
  visible: boolean;
}

export function SidePanel({ period, visible }: SidePanelProps) {
  if (!visible) return null;
  const P = fmtPeriod(period);

  return (
    <div
      className="absolute top-0 right-0 bottom-[84px] z-20 w-80 flex flex-col overflow-hidden"
      style={{
        background: 'rgba(6,10,20,0.88)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderLeft: '1px solid var(--border-base)',
        boxShadow: '-8px 0 40px rgba(0,0,0,0.5), inset 1px 0 0 var(--border-base)',
      }}
    >
      <div className="flex-1 overflow-y-auto">
        <SectionDivider label={`Overview · ${P}`} />
        <SummaryHeader period={period} />

        <Divider />
        <SectionDivider label={`Top Threat Origins · ${P}`} />
        <TopOriginsWidget period={period} />

        <Divider />
        <SectionDivider label={`Top Targeted Brands · ${P}`} />
        <TopBrandsWidget period={period} />

        <Divider />
        <SectionDivider label={"Hosting Providers · 7d trend"} />
        <ProvidersWidget />

        <Divider />
        <SectionDivider label="Active Operations" />
        <OperationsWidget />

        <Divider />
        <SectionDivider label={"Geopolitical Campaigns · 30d"} />
        <GeoCampaignsWidget />

        <Divider />
        <SectionDivider label="Agent Intelligence" />
        <AgentIntelWidget />

        <Divider />
        <SectionDivider label="Live Feed" />
        <LiveFeedWidget />
      </div>
    </div>
  );
}
