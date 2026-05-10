// Brand list v3 — three outcome-shaped tabs per .claude/plans/v3.md
// §9.6 + the user-driven reframe:
//
//   Intel     — what's happening across the brand catalog (default)
//   All Brands — the searchable grid (ports v2 list as-is)
//   Prospects — staff-only sales-intel surface, review-shaped
//
// Stage 1 scaffold — leans on existing v2 list for All Brands tab
// (Brands.tsx is 988 lines and well-tested; rebuilding it from
// scratch isn't the v3 IA value-add). The Intel and Prospects tabs
// are the new surfaces. Per-surface refinement (tier filter, Health/
// Exposure columns, sort improvements) ships in follow-up PRs once
// PR3's scoring populates and PR5's candidates accumulate.

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RTooltip } from 'recharts';
import { useAuth } from '@/lib/auth';
import { useBrandStats } from '@/hooks/useBrands';
import { useBrandMovers, type BrandMover } from '@/hooks/useBrandMovers';
import {
  useEmailSecurityAggregate,
  usePressureAggregate,
  useCompositionAggregate,
  usePostureAggregate,
  type EmailSecurityAggregate,
  type PressureMover,
  type CompositionAggregate,
  type PostureMover,
} from '@/hooks/useBrandAggregates';
import {
  useBrandCandidates,
  usePromoteBrandCandidate,
  useRejectBrandCandidate,
  type BrandCandidate,
} from '@/hooks/useBrandCandidates';
import { BrandsGrid } from './components/BrandsGrid';
import { Card } from '@/components/ui/Card';
import { DeepCard } from '@/components/ui/DeepCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import { timeAgo } from '@/lib/time';

const STAFF_ROLES = new Set(['super_admin', 'admin', 'analyst', 'sales', 'support', 'billing']);

const V3_TABS = [
  { id: 'intel',     label: 'Intel',      hint: "What's happening across the catalog",      staffOnly: false },
  { id: 'all',       label: 'All Brands', hint: 'Search the full brand catalog',            staffOnly: false },
  { id: 'prospects', label: 'Prospects',  hint: 'CT-driven candidates for sales review',   staffOnly: true  },
] as const;

type V3Tab = typeof V3_TABS[number]['id'];

export function BrandsV3() {
  const { user } = useAuth();
  const isStaff = !!user && STAFF_ROLES.has(user.role);

  // Default Option A: Intel for everyone (per design decision in
  // earlier conversation). Tenants see catalog-level intel filtered
  // to their org_brands binding via the underlying handler scope.
  const [activeTab, setActiveTab] = useState<V3Tab>('intel');

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header — title only; v2 brands surface decommissioned. */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Brands</h1>
      </div>

      {/* Sticky tab strip */}
      <div className="sticky top-0 z-10 bg-slate-950/90 backdrop-blur-lg border-b border-white/[0.06] -mx-6 px-6">
        <div className="flex gap-1 overflow-x-auto scrollbar-none">
          {V3_TABS.filter(t => !t.staffOnly || isStaff).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-shrink-0 px-4 py-3 text-xs font-bold transition-all border-b-2 ${
                activeTab === tab.id ? 'border-amber-500 text-amber-400' : 'border-transparent text-white/40 hover:text-white/70'
              }`}
              style={activeTab === tab.id ? { textShadow: '0 0 10px rgba(229,168,50,0.60)' } : undefined}
              title={tab.hint}
            >
              {tab.label}
              {tab.staffOnly && (
                <span className="ml-2 inline-block px-1.5 py-0.5 text-[8px] uppercase tracking-wider rounded bg-white/10 text-[var(--text-muted)]">
                  Staff
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'intel' && <IntelTab isStaff={isStaff} />}
      {activeTab === 'all' && <BrandsGrid />}
      {activeTab === 'prospects' && isStaff && <ProspectsTab />}
    </div>
  );
}

// ── INTEL ───────────────────────────────────────────────────────────────
// Catalog-level overview. "What's happening across the brand catalog
// this week." All data pulled from existing endpoints — no new backend
// work. The visual rebuild lifts the surface from "stat tiles + plain
// lists" (PR6 scaffold) to a chart-led intel surface with sector
// donut, threat-type breakdown bars, and DeepCard-treated stat hero.
function IntelTab({ isStaff }: { isStaff: boolean }) {
  const { data: stats, isLoading: statsLoading } = useBrandStats();
  const { data: movers, isLoading: moversLoading } = useBrandMovers();
  const { data: emailAgg } = useEmailSecurityAggregate();
  const { data: pressureAgg } = usePressureAggregate();
  const { data: compositionAgg } = useCompositionAggregate();
  const { data: postureAgg } = usePostureAggregate();

  return (
    <div className="space-y-5">
      <HeroStrip stats={stats} loading={statsLoading} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectorDonut breakdown={stats?.sector_breakdown ?? null} totalTracked={stats?.total_tracked ?? 0} />
        <ThreatTypeBreakdown stats={stats} />
        {isStaff
          ? <HotProspectsTeaser />
          : <CatalogStatusCard stats={stats} />
        }
      </div>

      {/* Defense panel — email-security grade distribution + DMARC mix */}
      <PanelHeader title="Defense" subtitle="Email-security posture across the catalog" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EmailGradeCard data={emailAgg} />
        <DmarcEnforcementCard data={emailAgg} />
      </div>

      {/* Pressure panel — top brands by external attack signals */}
      <PanelHeader title="Pressure" subtitle="Top brands by external attack signal" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <PressureLeaderboard
          title="Lookalikes"
          rows={pressureAgg?.top_lookalikes}
          accent="#E5A832"
          subtitle="Active typosquats"
        />
        <PressureLeaderboard
          title="Social impersonations"
          rows={pressureAgg?.top_social_imps}
          accent="#fb923c"
          subtitle="Suspicious or fake profiles"
        />
        <PressureLeaderboard
          title="App impersonations"
          rows={pressureAgg?.top_app_imps}
          accent="#C83C3C"
          subtitle="Fake mobile listings"
        />
        <PressureLeaderboard
          title="Dark-web mentions"
          rows={pressureAgg?.top_dark_web}
          accent="#9B59B6"
          subtitle="Confirmed paste / forum hits"
        />
      </div>

      {/* Composition panel — what does our catalog look like */}
      <PanelHeader title="Composition" subtitle="Catalog tier mix, source, prominence, geo" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CompositionMixCard data={compositionAgg} />
        <GeoDistributionCard data={compositionAgg} />
      </div>

      {/* Posture panel — Brand-Health + Brand-Exposure across catalog */}
      <PanelHeader title="Posture" subtitle="Defensive health vs offensive exposure" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ScoreBucketCard
          title="Brand-Health distribution"
          data={postureAgg?.health_score_buckets}
          tone="ok"
          subtitle={postureAgg ? `${formatNumber(postureAgg.total_scored)} brands scored` : 'Awaiting daily snapshot'}
        />
        <ScoreBucketCard
          title="Brand-Exposure distribution"
          data={postureAgg?.exposure_score_buckets}
          tone="crit"
          subtitle="Higher = more attack pressure"
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PostureMoversCard
          title="Improving brands"
          rows={postureAgg?.improving_brands}
          tone="ok"
          emptyMsg="No brands moving up >+5 health pts this week"
        />
        <PostureMoversCard
          title="Declining brands"
          rows={postureAgg?.declining_brands}
          tone="crit"
          emptyMsg="No brands moving down >-5 health pts this week"
        />
      </div>

      {/* Existing Most-attacked / Cooling movers */}
      <PanelHeader title="Activity" subtitle="Brands with the biggest threat-count delta this week" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MoversCard
          title="Most attacked this week"
          rows={movers?.rising ?? []}
          tone="crit"
          emptyMsg="No rising attack pressure this week"
          loading={moversLoading}
        />
        <MoversCard
          title="Cooling down"
          rows={movers?.falling ?? []}
          tone="ok"
          emptyMsg="No brands cooling significantly this week"
          loading={moversLoading}
        />
      </div>

      <CatalogStatusFooter />
    </div>
  );
}

// ── PanelHeader ────────────────────────────────────────────────
function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="pt-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-mono font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          {title}
        </h2>
        <span className="text-[11px] text-[var(--text-muted)]">{subtitle}</span>
      </div>
      <div className="mt-1 h-px bg-gradient-to-r from-white/[0.10] via-white/[0.04] to-transparent" />
    </div>
  );
}

// ── HeroStrip ────────────────────────────────────────────────────────
// 4 stat tiles using DeepCard with accent gradients, big numbers,
// and contextual sub-info. Replaces the flat 4-tile strip from the
// PR6 scaffold which had no visual hierarchy.
function HeroStrip({ stats, loading }: { stats: any; loading: boolean }) {
  const tiles = [
    {
      label: 'Total tracked',
      value: stats?.total_tracked != null ? formatNumber(stats.total_tracked) : '—',
      sub: 'across catalog',
      accent: '#E5A832',
    },
    {
      label: 'New this week',
      value: stats?.new_this_week != null ? `+${formatNumber(stats.new_this_week)}` : '—',
      sub: stats?.newest_brand_name ?? 'newly seeded',
      accent: '#3CB878',
    },
    {
      label: 'Fastest rising',
      value: stats?.fastest_rising_pct != null ? `+${stats.fastest_rising_pct}%` : '—',
      sub: stats?.fastest_rising ?? '7-day delta',
      accent: '#E8923C',
    },
    {
      label: 'Top attack',
      value: stats?.top_threat_type ? humanizeThreatType(stats.top_threat_type) : '—',
      sub: stats?.top_threat_type_pct != null ? `${stats.top_threat_type_pct}% of incidents` : 'across all brands',
      accent: '#C83C3C',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map((t, i) => (
        <DeepCard key={t.label} variant="active" accent={t.accent}
          style={{ padding: '18px 20px', position: 'relative', overflow: 'hidden', minHeight: 110 }}>
          <div style={{
            position: 'absolute', top: 12, left: 16,
            width: 4, height: 4, borderRadius: '50%',
            background: t.accent, boxShadow: `0 0 8px ${t.accent}`,
          }} />
          <div style={{
            position: 'absolute', right: -20, bottom: -20,
            width: 110, height: 110, borderRadius: '50%',
            background: `radial-gradient(circle, ${t.accent}30, transparent 70%)`,
            pointerEvents: 'none',
          }} />
          <div style={{ position: 'relative', marginTop: 4 }}>
            <div style={{
              fontSize: 9, fontFamily: 'monospace', letterSpacing: '0.20em',
              color: 'var(--text-tertiary)', textTransform: 'uppercase', marginBottom: 8,
            }}>
              {t.label}
            </div>
            <div style={{
              fontSize: i === 3 ? 22 : 30,
              fontWeight: 800,
              color: t.accent,
              textShadow: `0 0 12px ${t.accent}55`,
              textTransform: i === 3 ? 'capitalize' : 'none',
              lineHeight: 1.05,
            }}>
              {loading ? '…' : t.value}
            </div>
            {t.sub && (
              <div className="mt-1 text-[11px] font-mono text-[var(--text-tertiary)] truncate">
                {t.sub}
              </div>
            )}
          </div>
        </DeepCard>
      ))}
    </div>
  );
}

// ── SectorDonut ──────────────────────────────────────────────────────
// Replaces the empty grid of sector tiles (most Tranco-imported brands
// have no sector classified, so the grid was rendering blank). Uses
// recharts PieChart so even sparse data presents as an intelligible
// chart with a "%-of-classified" framing.
const SECTOR_COLORS = [
  '#E5A832', '#0A8AB5', '#3CB878', '#C83C3C', '#E8923C',
  '#9B59B6', '#1ABC9C', '#34495E',
];

function SectorDonut({ breakdown, totalTracked }: {
  breakdown: { sector: string; count: number }[] | null;
  totalTracked: number;
}) {
  const data = (breakdown ?? []).slice(0, 8);
  const sumClassified = data.reduce((s, x) => s + x.count, 0);
  const unclassified = Math.max(0, totalTracked - sumClassified);

  if (data.length === 0) {
    return (
      <Card hover={false} style={{ minHeight: 220 }}>
        <SectionLabel>Sector mix</SectionLabel>
        <div className="mt-3 flex items-center justify-center" style={{ height: 160 }}>
          <span className="text-xs text-[var(--text-tertiary)]">
            Sector classification pending for {formatNumber(totalTracked)} brands
          </span>
        </div>
      </Card>
    );
  }

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between">
        <SectionLabel>Sector mix</SectionLabel>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          {formatNumber(sumClassified)} classified
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 items-center">
        <div style={{ height: 160 }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={data} dataKey="count" nameKey="sector"
                innerRadius={42} outerRadius={68} paddingAngle={2} stroke="none">
                {data.map((_, i) => (
                  <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                ))}
              </Pie>
              <RTooltip
                contentStyle={{
                  background: 'var(--bg-card)', border: '1px solid var(--border-base)',
                  borderRadius: 6, fontSize: 11, fontFamily: 'monospace',
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="space-y-1">
          {data.map((s, i) => (
            <div key={s.sector} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2 min-w-0">
                <span style={{
                  width: 8, height: 8, borderRadius: 2,
                  background: SECTOR_COLORS[i % SECTOR_COLORS.length],
                  flexShrink: 0,
                }} />
                <span className="font-mono text-[var(--text-secondary)] truncate capitalize">
                  {s.sector}
                </span>
              </div>
              <span className="font-mono text-[var(--text-tertiary)] flex-shrink-0">
                {Math.round((s.count / sumClassified) * 100)}%
              </span>
            </div>
          ))}
          {unclassified > 0 && (
            <div className="flex items-center justify-between text-[11px] mt-2 pt-2 border-t border-white/[0.04]">
              <span className="font-mono text-[var(--text-muted)]">Unclassified</span>
              <span className="font-mono text-[var(--text-muted)]">
                {formatNumber(unclassified)}
              </span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── ThreatTypeBreakdown ──────────────────────────────────────────────
// Bar-chart of the top 3 threat types from useBrandStats. Replaces
// the implicit "Top attack" tile-only treatment with explicit ranking
// so an operator sees the full breakdown at a glance.
function ThreatTypeBreakdown({ stats }: { stats: any }) {
  const types: Array<{ name: string; pct: number; rank: number }> = [];
  if (stats?.top_threat_type) {
    types.push({ name: stats.top_threat_type, pct: stats.top_threat_type_pct ?? 0, rank: 1 });
  }
  if (stats?.second_threat_type) {
    types.push({ name: stats.second_threat_type, pct: 0, rank: 2 });
  }
  if (stats?.third_threat_type) {
    types.push({ name: stats.third_threat_type, pct: 0, rank: 3 });
  }

  // Bar widths: top one is the actual %, 2nd/3rd are scaled relative
  // to top so the visual hierarchy matches even when 2nd/3rd %s
  // aren't published by the endpoint.
  const topPct = types[0]?.pct ?? 0;

  return (
    <Card hover={false}>
      <SectionLabel>Attack types</SectionLabel>
      <div className="mt-3 space-y-2.5">
        {types.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">
            No threat type data yet
          </div>
        )}
        {types.map((t, i) => {
          const barPct = i === 0 ? topPct : Math.max(10, topPct - (i * 18));
          const accent = i === 0 ? '#C83C3C' : i === 1 ? '#E8923C' : '#DCAA32';
          return (
            <div key={t.name}>
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-[var(--text-primary)] capitalize">
                  {humanizeThreatType(t.name)}
                </span>
                <span className="text-[var(--text-tertiary)]">
                  {i === 0 ? `${t.pct}%` : `#${t.rank}`}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <div className="h-full rounded-full transition-all"
                  style={{
                    width: `${barPct}%`,
                    background: `linear-gradient(90deg, ${accent}, ${accent}80)`,
                    boxShadow: i === 0 ? `0 0 8px ${accent}55` : 'none',
                  }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── CatalogStatusCard ─────────────────────────────────────────────
// Non-staff fallback for the third column (Hot prospects is staff-
// only). Shows "what's running automatically" so customers
// understand the platform's freshness model.
function CatalogStatusCard({ stats }: { stats: any }) {
  const items = [
    { label: 'Tranco import',         schedule: 'Daily 06:00 UTC' },
    { label: 'Brand-Health snapshot', schedule: 'Daily 00:00 UTC' },
    { label: 'CT candidate sweep',    schedule: 'Daily 00:00 UTC' },
    { label: 'Firmographic enricher', schedule: 'Hourly' },
  ];
  return (
    <Card hover={false}>
      <SectionLabel>Catalog automation</SectionLabel>
      <div className="mt-3 space-y-2">
        {items.map(it => (
          <div key={it.label} className="flex items-center justify-between text-[11px] font-mono">
            <span className="flex items-center gap-2">
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--green)',
                boxShadow: '0 0 6px var(--green)',
              }} />
              <span className="text-[var(--text-secondary)]">{it.label}</span>
            </span>
            <span className="text-[var(--text-tertiary)]">{it.schedule}</span>
          </div>
        ))}
      </div>
      {stats?.total_tracked != null && (
        <div className="mt-3 pt-2 border-t border-white/[0.04] text-[10px] font-mono text-[var(--text-muted)]">
          Auto-sweeps {formatNumber(stats.total_tracked)} brands continuously
        </div>
      )}
    </Card>
  );
}

// ── CatalogStatusFooter ──────────────────────────────────────────────
// Catalog-wide status footer: "what just ran" / "next refresh in X."
// Keeps the user oriented without an admin button.
function CatalogStatusFooter() {
  return (
    <div className="text-[10px] font-mono text-[var(--text-muted)] text-center pt-2">
      Catalog data refreshes hourly; brand-health + exposure snapshots run nightly.
      Tranco rank refreshes daily.
    </div>
  );
}

function MoversCard({ title, rows, tone, emptyMsg, loading }: {
  title: string;
  rows: BrandMover[];
  tone: 'crit' | 'ok';
  emptyMsg: string;
  loading?: boolean;
}) {
  const navigate = useNavigate();
  const accent = tone === 'crit' ? 'var(--sev-critical)' : 'var(--green)';
  // Bar widths relative to the largest abs delta in this card's set
  const maxDelta = rows.length > 0
    ? Math.max(...rows.slice(0, 5).map(r => Math.abs(r.delta_7d)), 1)
    : 1;
  const top5 = rows.slice(0, 5);

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between">
        <SectionLabel>{title}</SectionLabel>
        {rows.length > 0 && (
          <span className="text-[10px] font-mono text-[var(--text-muted)]">
            top {Math.min(5, rows.length)} of {rows.length}
          </span>
        )}
      </div>
      <div className="mt-3 space-y-1.5">
        {loading && (
          <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">Loading…</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">{emptyMsg}</div>
        )}
        {top5.map(b => {
          const barPct = (Math.abs(b.delta_7d) / maxDelta) * 100;
          return (
            <div
              key={b.id}
              onClick={() => navigate(`/brands-v3/${b.id}`)}
              className="cursor-pointer hover:bg-white/[0.03] transition-colors group"
              style={{
                padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--border-base)', background: 'var(--bg-input)',
                position: 'relative', overflow: 'hidden',
              }}
            >
              {/* delta-magnitude bar — visual weight matches the data */}
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${barPct}%`,
                background: `linear-gradient(90deg, ${accent}18, ${accent}06)`,
                pointerEvents: 'none',
              }} />
              <div className="relative flex items-center gap-3">
                <BrandFavicon
                  name={b.name}
                  domain={b.canonical_domain}
                  logoUrl={b.logo_url}
                  size={28}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--amber)] transition-colors">
                    {b.name}
                  </div>
                  <div className="text-[11px] font-mono text-[var(--text-tertiary)] truncate">{b.canonical_domain}</div>
                </div>
                <div className="text-right flex-shrink-0" style={{ minWidth: 76 }}>
                  <div className="text-sm font-bold" style={{ color: accent, textShadow: `0 0 6px ${accent}55` }}>
                    {b.delta_7d >= 0 ? '+' : ''}{b.delta_7d}
                  </div>
                  <div className="text-[10px] font-mono text-[var(--text-muted)]">
                    {b.today_count} active
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Helpers ─────────────────────────────────────────────────────
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function humanizeThreatType(t: string): string {
  return (t || '').replace(/_/g, ' ');
}

// Compact favicon avatar for Intel-tab list rows. Uses the brand's
// stored logo_url when available, falls back to Google's S2 favicons
// API by canonical_domain, and finally to a letter chip if both fail.
function BrandFavicon({
  name, domain, logoUrl, size = 24,
}: {
  name: string;
  domain?: string | null;
  logoUrl?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const radius = Math.round(size * 0.25);
  const src = logoUrl
    ?? (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : null);

  return (
    <div style={{
      width: size, height: size, borderRadius: radius,
      background: 'linear-gradient(145deg, var(--bg-elevated), var(--bg-card-deep))',
      border: '1px solid var(--border-base)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', flexShrink: 0,
    }}>
      {src && !failed ? (
        <img
          src={src}
          width={Math.round(size * 0.65)}
          height={Math.round(size * 0.65)}
          alt={name}
          onError={() => setFailed(true)}
          style={{ borderRadius: 2, display: 'block' }}
        />
      ) : (
        <span style={{
          fontSize: Math.round(size * 0.4),
          fontWeight: 800,
          color: 'var(--text-secondary)',
        }}>
          {(name[0] ?? '?').toUpperCase()}
        </span>
      )}
    </div>
  );
}

function HotProspectsTeaser() {
  const navigate = useNavigate();
  const { data } = useBrandCandidates('pending');
  const top = (data?.candidates ?? []).slice(0, 3);
  if (top.length === 0) return null;
  return (
    <Card hover={false}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <SectionLabel>Hot prospects from CT</SectionLabel>
        <Badge variant="info">Staff</Badge>
      </div>
      <div className="space-y-2">
        {top.map(c => (
          <div key={c.id} style={{
            padding: '8px 12px', borderRadius: 6,
            border: '1px solid var(--border-base)', background: 'var(--bg-input)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <BrandFavicon name={c.apex_domain} domain={c.apex_domain} size={24} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-mono text-[var(--text-primary)] truncate">{c.apex_domain}</div>
              <div className="text-[11px] text-[var(--text-tertiary)]">
                {c.cert_count} certs · {c.distinct_issuers} issuers · seen {timeAgo(c.first_seen)}
              </div>
            </div>
          </div>
        ))}
        <button
          onClick={() => navigate('/brands-v3?tab=prospects')}
          className="w-full mt-1 text-[11px] font-mono text-[var(--amber)] hover:underline"
        >
          View {data?.total ?? 0} pending candidates →
        </button>
      </div>
    </Card>
  );
}

// ── PROSPECTS (staff only) ───────────────────────────────────────────
// CT-driven brand candidate review queue. Grouped by intent strength
// per user feedback ("not just some long list. sortable or some
// intelligence put into to make review easier").
type ProspectStatus = 'pending' | 'promoted' | 'rejected';

function ProspectsTab() {
  const [status, setStatus] = useState<ProspectStatus>('pending');
  const { data, isLoading } = useBrandCandidates(status);
  // Prefetch counts for the other status buckets so sub-tab labels show
  // counts even before the user clicks. Cheap — each call is staleTime 60s
  // and refetched on the same 5min interval as the active query.
  const pendingQ  = useBrandCandidates('pending');
  const promotedQ = useBrandCandidates('promoted');
  const rejectedQ = useBrandCandidates('rejected');
  const counts: Record<ProspectStatus, number> = {
    pending:  pendingQ.data?.total ?? 0,
    promoted: promotedQ.data?.total ?? 0,
    rejected: rejectedQ.data?.total ?? 0,
  };

  const promote = usePromoteBrandCandidate();
  const reject = useRejectBrandCandidate();
  const navigate = useNavigate();

  const all = data?.candidates ?? [];
  const grouped = useMemo(() => ({
    hot:    all.filter(c => c.cert_count >= 50),
    warm:   all.filter(c => c.cert_count >= 10 && c.cert_count < 50),
    worth:  all.filter(c => c.cert_count >= 3 && c.cert_count < 10),
  }), [all]);

  function handleReject(id: string) {
    const notes = window.prompt('Reason for rejecting (optional):', '');
    // Cancelled (null) → no-op. Empty string → reject without notes.
    if (notes === null) return;
    reject.mutate({ id, notes: notes || undefined });
  }

  return (
    <div className="space-y-4">
      {/* Status sub-tabs with live counts */}
      <div className="flex gap-1 border-b border-white/[0.06]">
        {(['pending', 'promoted', 'rejected'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider transition-colors border-b-2 flex items-center gap-2 ${
              status === s ? 'border-amber-500 text-amber-400' : 'border-transparent text-white/40 hover:text-white/70'
            }`}
          >
            <span>{s}</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] ${
              status === s ? 'bg-amber-500/20 text-amber-400' : 'bg-white/[0.05] text-white/40'
            }`}>
              {counts[s]}
            </span>
          </button>
        ))}
      </div>

      {isLoading && <div className="text-sm text-[var(--text-tertiary)]">Loading prospects…</div>}

      {!isLoading && all.length === 0 && (
        <EmptyState
          title={status === 'pending' ? 'No pending prospects'
               : status === 'promoted' ? 'No promoted candidates yet'
               : 'No rejected candidates yet'}
          description={status === 'pending'
            ? "The CT aggregator hasn't surfaced anything new for review. New candidates appear here daily as the CT log fills."
            : status === 'promoted'
            ? 'Once you promote a candidate, it lands here with a link back to the brand row.'
            : 'Rejections stay here as a negative training set so the same domain isn\'t re-proposed.'
          }
        />
      )}

      {!isLoading && all.length > 0 && status === 'pending' && (
        <>
          <ProspectGroup label="Hot leads" emoji="🔥" tone="crit" rows={grouped.hot}
            onPromote={(id) => promote.mutate(id)} onReject={handleReject}
            promotePending={promote.isPending} />
          <ProspectGroup label="Warm leads" emoji="🟡" tone="warn" rows={grouped.warm}
            onPromote={(id) => promote.mutate(id)} onReject={handleReject}
            promotePending={promote.isPending} />
          <ProspectGroup label="Worth a look" emoji="⚪" tone="info" rows={grouped.worth}
            onPromote={(id) => promote.mutate(id)} onReject={handleReject}
            promotePending={promote.isPending} />
        </>
      )}

      {!isLoading && all.length > 0 && status === 'promoted' && (
        <Card hover={false}>
          <div className="flex items-center justify-between mb-3">
            <SectionLabel>Promoted into the brand catalog</SectionLabel>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">{all.length} promoted</span>
          </div>
          <div className="space-y-2">
            {all.map(c => (
              <ReviewedRow key={c.id} c={c} onJumpBrand={(brandId) => navigate(`/brands-v3/${brandId}`)} />
            ))}
          </div>
        </Card>
      )}

      {!isLoading && all.length > 0 && status === 'rejected' && (
        <Card hover={false}>
          <div className="flex items-center justify-between mb-3">
            <SectionLabel>Rejected (negative examples)</SectionLabel>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">{all.length} rejected</span>
          </div>
          <div className="space-y-2">
            {all.map(c => <ReviewedRow key={c.id} c={c} />)}
          </div>
        </Card>
      )}
    </div>
  );
}

function ProspectGroup({ label, emoji, rows, tone = 'info', onPromote, onReject, promotePending }: {
  label: string; emoji: string; rows: BrandCandidate[];
  tone?: 'crit' | 'warn' | 'info';
  onPromote: (id: string) => void; onReject: (id: string) => void;
  promotePending: boolean;
}) {
  if (rows.length === 0) return null;
  const accent = tone === 'crit' ? '#C83C3C' : tone === 'warn' ? '#E8923C' : '#0A8AB5';
  // Hot leads use DeepCard with critical accent so they visually
  // dominate; warm/worth use plain Card for visual de-emphasis.
  const Wrapper = tone === 'crit' ? DeepCard : Card;
  const wrapperProps = tone === 'crit'
    ? { variant: 'active' as const, accent, hover: false }
    : { hover: false };
  return (
    <Wrapper {...wrapperProps}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>{emoji} {label}</SectionLabel>
        <span className="text-[11px] font-mono px-2 py-0.5 rounded"
          style={{ background: tone === 'crit' ? 'rgba(200,60,60,0.15)' : 'rgba(255,255,255,0.04)',
                   color: tone === 'crit' ? 'var(--sev-critical)' : 'var(--text-tertiary)' }}>
          {rows.length} pending
        </span>
      </div>
      <div className="space-y-2">
        {rows.map(c => {
          // Highlight candidates that landed in the queue in the last 3
          // days — operator-visible "what's new since I last looked"
          // signal without needing to track per-user last-visit time.
          const isRecent = (Date.now() - new Date(c.first_seen).getTime()) < 3 * 24 * 60 * 60_000;
          return (
            <div key={c.id} style={{
              padding: 12, borderRadius: 6,
              border: isRecent ? '1px solid rgba(229,168,50,0.30)' : '1px solid var(--border-base)',
              background: isRecent ? 'rgba(229,168,50,0.04)' : 'var(--bg-input)',
            }}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-mono font-semibold text-[var(--text-primary)] truncate flex items-center gap-2">
                    {c.apex_domain}
                    {isRecent && <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 uppercase tracking-wider">New</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] font-mono">
                    <span style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(229,168,50,0.10)', color: 'var(--amber)' }}>
                      {c.cert_count} certs
                    </span>
                    <span style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(10,138,181,0.10)', color: 'var(--blue)' }}>
                      {c.distinct_issuers} issuers
                    </span>
                    <span style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.04)', color: 'var(--text-tertiary)' }}>
                      seen {timeAgo(c.first_seen)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Button size="sm" variant="primary" onClick={() => onPromote(c.id)} disabled={promotePending}>
                    Promote
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onReject(c.id)}>
                    Reject
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Wrapper>
  );
}

function ReviewedRow({ c, onJumpBrand }: { c: BrandCandidate; onJumpBrand?: (brandId: string) => void }) {
  return (
    <div style={{
      padding: 10, borderRadius: 6,
      border: '1px solid var(--border-base)', background: 'var(--bg-input)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    }}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-mono text-[var(--text-primary)] truncate">{c.apex_domain}</div>
        <div className="mt-0.5 text-[10px] font-mono text-[var(--text-muted)]">
          {c.cert_count} certs · {c.distinct_issuers} issuers
          {c.reviewed_at && <> · {c.status} {timeAgo(c.reviewed_at)}</>}
          {c.reviewed_by && <> by {c.reviewed_by}</>}
        </div>
        {c.notes && (
          <div className="mt-1 text-[10px] text-[var(--text-tertiary)] italic">"{c.notes}"</div>
        )}
      </div>
      {c.status === 'promoted' && c.promoted_brand_id && onJumpBrand && (
        <Button size="sm" variant="ghost" onClick={() => onJumpBrand(c.promoted_brand_id!)}>
          View brand →
        </Button>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Defense panel — email security
// ══════════════════════════════════════════════════════════════════

const GRADE_TONE: Record<string, string> = {
  'A+': '#3CB878', 'A': '#3CB878', 'A-': '#3CB878',
  'B+': '#0A8AB5', 'B': '#0A8AB5', 'B-': '#0A8AB5',
  'C+': '#DCAA32', 'C': '#DCAA32', 'C-': '#DCAA32',
  'D+': '#E8923C', 'D': '#E8923C', 'D-': '#E8923C',
  'F':  '#C83C3C',
};

function EmailGradeCard({ data }: { data: EmailSecurityAggregate | null | undefined }) {
  if (!data) {
    return (
      <Card hover={false}><SectionLabel>Email security grade</SectionLabel>
        <div className="mt-3 text-xs text-[var(--text-tertiary)]">Loading…</div>
      </Card>
    );
  }
  const total = data.grade_distribution.reduce((s, r) => s + r.count, 0);
  const max = Math.max(1, ...data.grade_distribution.map(r => r.count));

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between">
        <SectionLabel>Email security grade</SectionLabel>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          {formatNumber(total)} graded
          {data.ungraded > 0 && ` · ${formatNumber(data.ungraded)} pending`}
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {data.grade_distribution.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-2">No graded brands yet</div>
        )}
        {data.grade_distribution.map(row => {
          const pct = total > 0 ? (row.count / total) * 100 : 0;
          const barW = (row.count / max) * 100;
          const accent = GRADE_TONE[row.grade] ?? '#78A0C8';
          return (
            <div key={row.grade}>
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span className="font-bold" style={{ color: accent }}>{row.grade}</span>
                <span className="text-[var(--text-tertiary)]">
                  {formatNumber(row.count)} <span className="text-[var(--text-muted)]">({pct.toFixed(1)}%)</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <div className="h-full rounded-full"
                  style={{ width: `${barW}%`, background: `linear-gradient(90deg, ${accent}, ${accent}80)` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function DmarcEnforcementCard({ data }: { data: EmailSecurityAggregate | null | undefined }) {
  if (!data) {
    return (
      <Card hover={false}><SectionLabel>DMARC enforcement</SectionLabel>
        <div className="mt-3 text-xs text-[var(--text-tertiary)]">Loading…</div>
      </Card>
    );
  }
  const total = data.dmarc_distribution.reduce((s, r) => s + r.count, 0);
  const POLICY_COLORS: Record<string, string> = {
    reject: '#3CB878', quarantine: '#0A8AB5',
    none: '#E8923C', unspecified: '#9B59B6',
  };
  const enforcePct = total > 0 ? (data.dmarc_enforcing / total) * 100 : 0;

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between">
        <SectionLabel>DMARC enforcement</SectionLabel>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          {formatNumber(total)} scanned
        </span>
      </div>
      <div className="mt-3">
        <div className="text-2xl font-bold" style={{ color: 'var(--green)', textShadow: '0 0 8px rgba(60,184,120,0.55)' }}>
          {enforcePct.toFixed(0)}%
        </div>
        <div className="text-[11px] font-mono text-[var(--text-tertiary)]">
          {formatNumber(data.dmarc_enforcing)} enforcing (quarantine + reject)
        </div>
      </div>
      <div className="mt-4 space-y-1.5">
        {data.dmarc_distribution.map(row => {
          const pct = total > 0 ? (row.count / total) * 100 : 0;
          const accent = POLICY_COLORS[row.policy] ?? '#78A0C8';
          return (
            <div key={row.policy} className="flex items-center justify-between text-[11px] font-mono">
              <div className="flex items-center gap-2">
                <span style={{ width: 8, height: 8, borderRadius: 2, background: accent }} />
                <span className="text-[var(--text-secondary)] capitalize">{row.policy}</span>
              </div>
              <span className="text-[var(--text-tertiary)]">
                {formatNumber(row.count)} <span className="text-[var(--text-muted)]">({pct.toFixed(0)}%)</span>
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// Pressure panel — leaderboards
// ══════════════════════════════════════════════════════════════════

function PressureLeaderboard({ title, rows, accent, subtitle }: {
  title: string;
  rows: PressureMover[] | undefined;
  accent: string;
  subtitle: string;
}) {
  const navigate = useNavigate();
  const top5 = (rows ?? []).slice(0, 5);
  const max = Math.max(1, ...top5.map(r => r.count));

  return (
    <Card hover={false} style={{ minHeight: 200 }}>
      <SectionLabel>{title}</SectionLabel>
      <div className="text-[10px] font-mono text-[var(--text-muted)] mt-0.5">{subtitle}</div>
      <div className="mt-3 space-y-1.5">
        {top5.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-3 text-center">No signal yet</div>
        )}
        {top5.map(b => {
          const barW = (b.count / max) * 100;
          return (
            <div key={b.brand_id}
              onClick={() => navigate(`/brands/${b.brand_id}`)}
              className="cursor-pointer hover:bg-white/[0.03] transition-colors"
              style={{
                padding: '6px 8px', borderRadius: 5,
                position: 'relative', overflow: 'hidden',
              }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${barW}%`,
                background: `linear-gradient(90deg, ${accent}1a, transparent)`,
              }} />
              <div className="relative flex items-center gap-2">
                <BrandFavicon name={b.brand_name} domain={b.canonical_domain} logoUrl={b.logo_url} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-[var(--text-primary)] truncate">{b.brand_name}</div>
                </div>
                <span className="text-xs font-bold" style={{ color: accent }}>{b.count}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// Composition panel
// ══════════════════════════════════════════════════════════════════

const TIER_COLORS: Record<string, string> = {
  customer: '#3CB878', monitored: '#E5A832', tracked: '#78A0C8',
};

function CompositionMixCard({ data }: { data: CompositionAggregate | null | undefined }) {
  if (!data) {
    return (
      <Card hover={false}><SectionLabel>Catalog composition</SectionLabel>
        <div className="mt-3 text-xs text-[var(--text-tertiary)]">Loading…</div>
      </Card>
    );
  }
  return (
    <Card hover={false}>
      <div className="flex items-center justify-between">
        <SectionLabel>Catalog composition</SectionLabel>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          {formatNumber(data.total)} total
        </span>
      </div>

      <div className="mt-3">
        <div className="text-[10px] font-mono text-[var(--text-muted)] uppercase tracking-wider">Tier</div>
        <StackedBar data={data.tier_mix.map(t => ({ key: t.tier, value: t.count, color: TIER_COLORS[t.tier] ?? '#78A0C8' }))} total={data.total} />
      </div>

      <div className="mt-4">
        <div className="text-[10px] font-mono text-[var(--text-muted)] uppercase tracking-wider">Tranco rank</div>
        <div className="mt-1 space-y-1">
          {data.tranco_buckets.map(b => {
            const pct = data.total > 0 ? (b.count / data.total) * 100 : 0;
            return (
              <div key={b.bucket} className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-[var(--text-secondary)]">{b.bucket}</span>
                <span className="text-[var(--text-tertiary)]">
                  {formatNumber(b.count)} <span className="text-[var(--text-muted)]">({pct.toFixed(0)}%)</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[10px] font-mono text-[var(--text-muted)] uppercase tracking-wider">Source</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {data.source_mix.slice(0, 6).map(s => (
            <span key={s.source} style={{
              padding: '2px 8px', borderRadius: 3,
              background: 'rgba(255,255,255,0.04)',
              fontSize: 10, fontFamily: 'monospace',
              color: 'var(--text-tertiary)',
            }}>
              {s.source.replace(/_/g, ' ')} <span className="text-[var(--text-muted)]">{formatNumber(s.count)}</span>
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function StackedBar({ data, total }: {
  data: Array<{ key: string; value: number; color: string }>;
  total: number;
}) {
  if (total === 0) return null;
  return (
    <div className="mt-1">
      <div className="flex h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
        {data.map(d => {
          const pct = (d.value / total) * 100;
          if (pct < 0.1) return null;
          return (
            <div key={d.key} title={`${d.key} ${formatNumber(d.value)}`}
              style={{ width: `${pct}%`, background: d.color }} />
          );
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] font-mono">
        {data.map(d => (
          <span key={d.key} className="flex items-center gap-1.5 text-[var(--text-tertiary)]">
            <span style={{ width: 8, height: 8, borderRadius: 2, background: d.color }} />
            <span className="capitalize">{d.key}</span>
            <span className="text-[var(--text-muted)]">{formatNumber(d.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function GeoDistributionCard({ data }: { data: CompositionAggregate | null | undefined }) {
  if (!data) {
    return (
      <Card hover={false}><SectionLabel>Geographic distribution</SectionLabel>
        <div className="mt-3 text-xs text-[var(--text-tertiary)]">Loading…</div>
      </Card>
    );
  }
  const top10 = data.hq_countries.slice(0, 10);
  const max = Math.max(1, ...top10.map(c => c.count));
  const totalGeo = top10.reduce((s, c) => s + c.count, 0);
  const unknown = data.total - data.hq_countries.reduce((s, c) => s + c.count, 0);

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between">
        <SectionLabel>Geographic distribution</SectionLabel>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          top 10 of {data.hq_countries.length}{unknown > 0 ? ` · ${formatNumber(unknown)} unknown` : ''}
        </span>
      </div>
      <div className="mt-3 space-y-1.5">
        {top10.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-2">No HQ data resolved yet</div>
        )}
        {top10.map(c => {
          const barW = (c.count / max) * 100;
          const pct = totalGeo > 0 ? (c.count / totalGeo) * 100 : 0;
          return (
            <div key={c.country}>
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-[var(--text-secondary)]">{c.country}</span>
                <span className="text-[var(--text-tertiary)]">
                  {formatNumber(c.count)} <span className="text-[var(--text-muted)]">({pct.toFixed(1)}%)</span>
                </span>
              </div>
              <div className="mt-1 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <div className="h-full rounded-full"
                  style={{ width: `${barW}%`, background: 'linear-gradient(90deg, var(--blue), var(--blue-dim))' }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// Posture panel
// ══════════════════════════════════════════════════════════════════

function ScoreBucketCard({ title, data, tone, subtitle }: {
  title: string;
  data: Array<{ bucket: string; count: number }> | undefined;
  tone: 'ok' | 'crit';
  subtitle: string;
}) {
  if (!data) {
    return (
      <Card hover={false}><SectionLabel>{title}</SectionLabel>
        <div className="mt-3 text-xs text-[var(--text-tertiary)]">Awaiting daily snapshot</div>
      </Card>
    );
  }
  const total = data.reduce((s, r) => s + r.count, 0);
  const max = Math.max(1, ...data.map(r => r.count));

  const okPalette  = ['#3CB878', '#0A8AB5', '#DCAA32', '#E8923C', '#C83C3C'];
  const palette = tone === 'crit' ? [...okPalette].reverse() : okPalette;

  return (
    <Card hover={false}>
      <div className="flex items-center justify-between">
        <SectionLabel>{title}</SectionLabel>
        <span className="text-[10px] font-mono text-[var(--text-muted)]">
          {formatNumber(total)} scored
        </span>
      </div>
      <div className="mt-1 text-[10px] font-mono text-[var(--text-muted)]">{subtitle}</div>
      <div className="mt-3 space-y-1.5">
        {data.map((row, i) => {
          if (row.bucket === 'unscored') return null;
          const barW = (row.count / max) * 100;
          const color = palette[i % palette.length];
          return (
            <div key={row.bucket}>
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span style={{ color }}>{row.bucket}</span>
                <span className="text-[var(--text-tertiary)]">{formatNumber(row.count)}</span>
              </div>
              <div className="mt-0.5 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <div className="h-full rounded-full" style={{ width: `${barW}%`, background: `linear-gradient(90deg, ${color}, ${color}80)` }} />
              </div>
            </div>
          );
        })}
        {data.find(r => r.bucket === 'unscored') && (
          <div className="text-[10px] font-mono text-[var(--text-muted)] pt-1 border-t border-white/[0.04]">
            {formatNumber(data.find(r => r.bucket === 'unscored')!.count)} not yet scored
          </div>
        )}
      </div>
    </Card>
  );
}

function PostureMoversCard({ title, rows, tone, emptyMsg }: {
  title: string;
  rows: PostureMover[] | undefined;
  tone: 'ok' | 'crit';
  emptyMsg: string;
}) {
  const navigate = useNavigate();
  const accent = tone === 'crit' ? 'var(--sev-critical)' : 'var(--green)';
  const list = rows ?? [];

  return (
    <Card hover={false}>
      <SectionLabel>{title}</SectionLabel>
      <div className="text-[10px] font-mono text-[var(--text-muted)] mt-0.5">
        Brand-Health Δ vs 7 days ago
      </div>
      <div className="mt-3 space-y-1.5">
        {list.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-3 text-center">{emptyMsg}</div>
        )}
        {list.map(b => (
          <div key={b.brand_id}
            onClick={() => navigate(`/brands/${b.brand_id}`)}
            className="cursor-pointer hover:bg-white/[0.03] transition-colors"
            style={{
              padding: '8px 10px', borderRadius: 6,
              border: '1px solid var(--border-base)', background: 'var(--bg-input)',
            }}>
            <div className="flex items-center gap-2">
              <BrandFavicon name={b.brand_name} domain={b.canonical_domain} logoUrl={b.logo_url} size={22} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-[var(--text-primary)] truncate">{b.brand_name}</div>
                <div className="text-[10px] font-mono text-[var(--text-tertiary)]">latest {b.latest}</div>
              </div>
              <span className="text-sm font-bold flex-shrink-0" style={{ color: accent }}>
                {b.delta > 0 ? '+' : ''}{b.delta}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

