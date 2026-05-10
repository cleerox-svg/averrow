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
import { useAuth } from '@/lib/auth';
import { useBrandStats, useBrands } from '@/hooks/useBrands';
import { useBrandMovers } from '@/hooks/useBrandMovers';
import {
  useBrandCandidates,
  usePromoteBrandCandidate,
  useRejectBrandCandidate,
  type BrandCandidate,
} from '@/hooks/useBrandCandidates';
import { Brands as BrandsV2 } from '@/features/brands/Brands';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { EmptyState } from '@/components/ui/EmptyState';
import { VersionToggle } from '@/components/ui/VersionToggle';
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
      {/* Header — title + toggle pill */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Brands</h1>
        <VersionToggle surface="brands" ariaLabel="Brands version" />
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
      {activeTab === 'all' && <BrandsV2 />}
      {activeTab === 'prospects' && isStaff && <ProspectsTab />}
    </div>
  );
}

// ── INTEL ───────────────────────────────────────────────────────────────
// Catalog-level overview. "What's happening across the brand catalog
// this week." Each tile pulls existing endpoints — no new backend work.
function IntelTab({ isStaff }: { isStaff: boolean }) {
  const { data: stats } = useBrandStats();
  const { data: movers } = useBrandMovers();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Total tracked"       value={String(stats?.total_tracked ?? 0)} />
        <StatTile label="New this week"       value={String(stats?.new_this_week ?? 0)}
                  sub={stats?.newest_brand_name ?? undefined} />
        <StatTile label="Fastest rising"      value={`${stats?.fastest_rising_pct ?? 0}%`}
                  sub={stats?.fastest_rising ?? undefined} tone="warn" />
        <StatTile label="Top attack"          value={(stats?.top_threat_type ?? '—').replace(/_/g, ' ')}
                  tone="crit" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MoversCard
          title="Most attacked this week"
          rows={movers?.rising ?? []}
          tone="crit"
          emptyMsg="No rising attack pressure this week"
        />
        <MoversCard
          title="Cooling down"
          rows={movers?.falling ?? []}
          tone="ok"
          emptyMsg="No brands cooling significantly this week"
        />
      </div>

      <Card hover={false}>
        <SectionLabel>Sector mix</SectionLabel>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(stats?.sector_breakdown ?? []).slice(0, 8).map(s => (
            <div key={s.sector} style={{
              padding: 12, borderRadius: 8,
              border: '1px solid var(--border-base)', background: 'var(--bg-input)',
            }}>
              <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-[var(--text-muted)]">
                {s.sector}
              </div>
              <div className="mt-1 text-lg font-bold text-[var(--text-primary)]">{s.count}</div>
            </div>
          ))}
        </div>
      </Card>

      {isStaff && <HotProspectsTeaser />}
    </div>
  );
}

function MoversCard({ title, rows, tone, emptyMsg }: {
  title: string;
  rows: Array<{ id: string; name: string; canonical_domain: string; today_count: number; delta_7d: number }>;
  tone: 'crit' | 'ok';
  emptyMsg: string;
}) {
  const navigate = useNavigate();
  const accent = tone === 'crit' ? 'var(--sev-critical)' : 'var(--green)';
  return (
    <Card hover={false}>
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-3 space-y-2">
        {rows.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">{emptyMsg}</div>
        )}
        {rows.slice(0, 5).map(b => (
          <div
            key={b.id}
            onClick={() => navigate(`/brands-v3/${b.id}`)}
            className="cursor-pointer hover:bg-white/[0.02] transition-colors"
            style={{
              padding: '8px 12px', borderRadius: 6,
              border: '1px solid var(--border-base)', background: 'var(--bg-input)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-[var(--text-primary)] truncate">{b.name}</div>
              <div className="text-[11px] font-mono text-[var(--text-tertiary)] truncate">{b.canonical_domain}</div>
            </div>
            <div className="text-right" style={{ minWidth: 70 }}>
              <div className="text-sm font-bold" style={{ color: accent }}>
                {b.delta_7d >= 0 ? '+' : ''}{b.delta_7d}
              </div>
              <div className="text-[10px] font-mono text-[var(--text-muted)]">
                {b.today_count} active
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
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
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }}>
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
function ProspectsTab() {
  const { data, isLoading } = useBrandCandidates('pending');
  const promote = usePromoteBrandCandidate();
  const reject = useRejectBrandCandidate();

  const grouped = useMemo(() => {
    const all = data?.candidates ?? [];
    return {
      hot:    all.filter(c => c.cert_count >= 50),
      warm:   all.filter(c => c.cert_count >= 10 && c.cert_count < 50),
      worth:  all.filter(c => c.cert_count >= 3 && c.cert_count < 10),
    };
  }, [data]);

  if (isLoading) {
    return <div className="text-sm text-[var(--text-tertiary)]">Loading prospects…</div>;
  }

  if ((data?.candidates ?? []).length === 0) {
    return (
      <EmptyState
        title="No pending prospects"
        description="The CT aggregator hasn't surfaced anything new for review. New candidates appear here daily as the CT log fills."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ProspectGroup
        label="Hot leads"
        emoji="🔥"
        rows={grouped.hot}
        onPromote={(id) => promote.mutate(id)}
        onReject={(id) => reject.mutate({ id })}
        promotePending={promote.isPending}
      />
      <ProspectGroup
        label="Warm leads"
        emoji="🟡"
        rows={grouped.warm}
        onPromote={(id) => promote.mutate(id)}
        onReject={(id) => reject.mutate({ id })}
        promotePending={promote.isPending}
      />
      <ProspectGroup
        label="Worth a look"
        emoji="⚪"
        rows={grouped.worth}
        onPromote={(id) => promote.mutate(id)}
        onReject={(id) => reject.mutate({ id })}
        promotePending={promote.isPending}
      />
    </div>
  );
}

function ProspectGroup({ label, emoji, rows, onPromote, onReject, promotePending }: {
  label: string; emoji: string; rows: BrandCandidate[];
  onPromote: (id: string) => void; onReject: (id: string) => void;
  promotePending: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <Card hover={false}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>{emoji} {label}</SectionLabel>
        <span className="text-[11px] font-mono text-[var(--text-muted)]">{rows.length} pending</span>
      </div>
      <div className="space-y-2">
        {rows.map(c => (
          <div key={c.id} style={{
            padding: 12, borderRadius: 6,
            border: '1px solid var(--border-base)', background: 'var(--bg-input)',
          }}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-mono font-semibold text-[var(--text-primary)] truncate">
                  {c.apex_domain}
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
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => onPromote(c.id)}
                  disabled={promotePending}
                >
                  Promote
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onReject(c.id)}
                >
                  Reject
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Shared tile ──────────────────────────────────────────────────────
function StatTile({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'warn' | 'crit';
}) {
  const valueColor = tone === 'crit' ? 'var(--sev-critical)'
    : tone === 'warn' ? 'var(--amber)'
    : 'var(--text-primary)';
  return (
    <div style={{
      padding: 14, borderRadius: 8,
      border: '1px solid var(--border-base)', background: 'var(--bg-card)',
    }}>
      <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold" style={{ color: valueColor }}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-[var(--text-tertiary)] truncate">{sub}</div>}
    </div>
  );
}
