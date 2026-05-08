/**
 * Observatory v3 Side Panel — curated intelligence widgets.
 *
 * Widgets:
 *   1. Top Targeted Brands (7d)
 *   2. Hosting Providers — Top 2 Worsening + Top 2 Improving (7d)
 *   3. Active Operations — Top 2 (7d)
 *   4. Geopolitical Campaigns (active, last 30d)
 */

import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBrands } from '@/hooks/useBrands';
import { useDashboardProviders } from '@/hooks/useProviders';
import type { DashboardProvider } from '@/hooks/useProviders';
import { useOperations } from '@/hooks/useOperations';
import { useGeopoliticalCampaigns } from '@/hooks/useGeopoliticalCampaign';
import { DimensionalAvatar } from '@/components/ui/DimensionalAvatar';
import { Badge } from '@/components/ui/Badge';

// ─── Section divider ────────────────────────────────────────
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

// ─── Provider row ───────────────────────────────────────────
function ProviderRow({ p, direction }: { p: DashboardProvider; direction: 'worsening' | 'improving' }) {
  const trendPct = p.trend_7d_pct;
  const trendColor = direction === 'worsening' ? 'var(--sev-critical)' : 'var(--sev-info)';
  const arrow = direction === 'worsening' ? '↑' : '↓';

  return (
    <div className="flex items-center justify-between py-1.5">
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
  const { data: brands = [] } = useBrands({ view: 'top', limit: 5, timeRange: period });

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

// ─── Providers Worsening / Improving ────────────────────────
const ProvidersWidget = memo(function ProvidersWidget() {
  const { data: worsening = [] } = useDashboardProviders('worst', 2);
  const { data: improving = [] } = useDashboardProviders('improving', 2);

  return (
    <div className="px-4 pb-2">
      {/* Worsening */}
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
      {/* Improving */}
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
  const { data: operations = [] } = useOperations({ status: 'active', limit: 2 });

  return (
    <div className="px-4 pb-2">
      {operations.length === 0 ? (
        <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>No active operations</div>
      ) : (
        operations.map((op) => {
          const countries = op.countries ? JSON.parse(op.countries) as string[] : [];
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

  // Filter to campaigns active in last 30 days
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
                {targets.length > 0 && <span> {'\u2192'} {targets.slice(0, 2).join(', ')}</span>}
              </div>
            </div>
          );
        })
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

  return (
    <div
      className="absolute top-0 right-0 bottom-[84px] z-20 w-80 flex flex-col overflow-hidden"
      style={{
        background: 'rgba(6,10,20,0.88)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderLeft: '1px solid var(--border-base)',
        boxShadow: '-8px 0 40px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex-1 overflow-y-auto">
        <SectionDivider label={"Top Targeted Brands \u00b7 7d"} />
        <TopBrandsWidget period={period} />

        <Divider />
        <SectionDivider label={"Hosting Providers \u00b7 7d"} />
        <ProvidersWidget />

        <Divider />
        <SectionDivider label="Active Operations" />
        <OperationsWidget />

        <Divider />
        <SectionDivider label={"Geopolitical Campaigns \u00b7 30d"} />
        <GeoCampaignsWidget />
      </div>
    </div>
  );
}
