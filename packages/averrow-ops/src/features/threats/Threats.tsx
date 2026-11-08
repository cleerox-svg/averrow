import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { accentText } from '@/lib/accent-text';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ThreatsTable, useThreatsTable, type ThreatRow } from '@averrow/shared/threats-table';
import { api } from '@/lib/api';
import {
  Card,
  KitButton,
  PageHeader,
  PageState,
} from '@/design-system/components';
import { ThreatInflowChart } from './ThreatInflowChart';
import { MultiFeedConsensusPanel } from './MultiFeedConsensusPanel';
import { PanelHeader } from './PanelHeader';
import { sentenceCase } from '@/lib/sentence-case';
import { THREATS_CARD_VARIANT } from './threatsCard';
import './threats.css';
import { ShieldCheck, Network, Users, Activity, TrendingUp } from 'lucide-react';
import { useThreatAggregate, type ThreatAggregateFilters, type ThreatAggregate } from '@/hooks/useThreatAggregate';
import { tabUrl } from '@/lib/workspaceRoutes';

interface Threat {
  id: string;
  threat_type: string;
  severity: string | null;
  status: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  ip_address: string | null;
  target_brand_id: string | null;
  brand_name: string | null;
  actor_id: string | null;
  actor_name: string | null;
  country_code: string | null;
  created_at: string;
  saas_technique_id: string | null;
  saas_technique_name: string | null;
  saas_technique_phase: string | null;
  saas_technique_phase_label: string | null;
  saas_technique_severity: string | null;
}

export function Threats() {
  const navigate = useNavigate();
  const location = useLocation();
  const sliceRef = useRef<HTMLDivElement>(null);
  // One-shot signal from the Corroboration panel (router state, not a URL param):
  // Console remounts this view when `q` changes, so the scroll must happen here,
  // on the NEW table, after mount. Clear the state so refresh/back don't re-scroll.
  // The scroll itself is deferred until the new list has settled (see below):
  // scrolling on mount clamps against a still-short .v4-outlet.
  const focusTable = (location.state as { focusTable?: boolean } | null)?.focusTable === true;
  const pendingFocusRef = useRef(false);
  useEffect(() => {
    if (!focusTable) return;
    pendingFocusRef.current = true;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [focusTable, navigate, location.pathname, location.search]);
  const { user } = useAuth();
  // PATCH /api/threats/:id is requireAdmin-gated, so only surface the triage
  // control to admins — analysts would hit a 403. (Relaxing the endpoint to
  // requireStaff is a separate permission decision.)
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const qc = useQueryClient();
  const updateThreat = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/api/threats/${id}`, { status }),
    // Optimistic — the list query carries a 5-min server KV cache, so a plain
    // refetch could show stale status for minutes. Patch the row in-place, then
    // reconcile on settle.
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ['threats'] });
      const prev = qc.getQueriesData<{ threats: ThreatRow[]; total: number }>({ queryKey: ['threats'] });
      qc.setQueriesData<{ threats: ThreatRow[]; total: number }>({ queryKey: ['threats'] }, (old) =>
        old?.threats
          ? { ...old, threats: old.threats.map(t => (t.id === id ? { ...t, status } : t)) }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['threats'] });
      qc.invalidateQueries({ queryKey: ['threat-aggregate'] });
    },
  });
  const [searchParams] = useSearchParams();
  const initialBrandId = searchParams.get('brand_id') ?? '';
  // `q` lets pivots deep-link a specific threat by its domain/URL/IP — e.g.
  // Campaign→Threat lands here pre-filtered to that indicator (there is no
  // single-threat route; the filtered table is the resolution).
  const initialQuery = searchParams.get('q') ?? '';
  // `country` (ISO-2) lets the Observatory's "Open in Threats" land on that country's list.
  const initialCountry = (searchParams.get('country') ?? '').trim().toUpperCase();
  const seededState = {
    ...(initialBrandId ? { brandId: initialBrandId } : {}),
    ...(initialQuery ? { q: initialQuery } : {}),
    ...(/^[A-Z]{2}$/.test(initialCountry) ? { country: initialCountry } : {}),
  };
  const table = useThreatsTable({
    pageSize: 50,
    initial: Object.keys(seededState).length ? seededState : undefined,
  });
  const s = table.state;

  // Aggregate fuels the slice-summary strip + brand/country option lists,
  // driven by the shared table's filter state.
  const filters: ThreatAggregateFilters = useMemo(() => ({
    severity: s.severity || undefined,
    type:     s.type || undefined,
    status:   s.status || undefined,
    country:  s.country || undefined,
    brand_id: s.brandId || undefined,
    search:   s.q || undefined,
  }), [s.severity, s.type, s.status, s.country, s.brandId, s.q]);
  const { data: agg, isError: aggError, refetch: refetchAgg } = useThreatAggregate(filters);
  // A failed aggregate is an error, never "no multi-brand patterns" / 0 tiles.
  const aggFailed = aggError && !agg;
  const retryAgg = () => { void refetchAgg(); };

  const { data, isLoading, isFetching, isPlaceholderData } = useQuery({
    queryKey: ['threats', table.params],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set('limit', String(table.params.limit));
      p.set('offset', String(table.params.offset));
      p.set('sort', table.params.sort);
      p.set('dir', table.params.dir);
      if (s.severity) p.set('severity', s.severity);
      if (s.type)     p.set('type', s.type);
      if (s.status)   p.set('status', s.status);
      if (s.country)  p.set('country', s.country);
      if (s.brandId)  p.set('brand_id', s.brandId);
      if (s.q)        p.set('q', s.q);
      const res = await api.get<{ threats: Threat[]; total: number }>(`/api/threats?${p}`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed');
      return res.data;
    },
    placeholderData: keepPreviousData,
  });

  // Fire once, after the list query settles (data, empty, or error alike).
  const listSettled = !isFetching && !isPlaceholderData;
  useEffect(() => {
    if (!listSettled || !pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    const el = sliceRef.current;
    if (!el) return;
    const reduce = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Next frame so the settled list has laid out and .v4-outlet has its full height.
    requestAnimationFrame(() => {
      el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      el.focus({ preventScroll: true });
    });
  }, [listSettled]);

  const brandOpts = (agg?.top_brands ?? []).map((b) => ({ value: b.brand_id, label: b.brand_name ?? b.brand_id }));
  const countryOpts = (agg?.top_countries ?? []).map((c) => ({ value: c.country, label: c.country }));
  const hasAnyFilter = !!(s.severity || s.type || s.status || s.country || s.brandId || s.q);

  return (
    <div className="threats-v4 p-6 space-y-5 max-w-7xl">
      {/* Count in `meta` (not subtitle) so it survives the Console embedding. */}
      <PageHeader
        title="Threats"
        meta={agg ? <span>{agg.total.toLocaleString()} in slice · {agg.active.toLocaleString()} active</span> : undefined}
      />

      <SliceSummaryStrip agg={agg} hasFilters={hasAnyFilter} />

      <HeroStrip agg={agg} failed={aggFailed} />

      <ThreatInflowChart />

      <PanelHeader title="Coordination" subtitle="Patterns hitting multiple brands at once" />
      <MultiBrandPanel agg={agg} failed={aggFailed} onRetry={retryAgg} />
      <MultiFeedConsensusPanel />

      <PanelHeader title="Evolving" subtitle="What's growing week-over-week" />
      <SurgingSignalsPanel agg={agg} failed={aggFailed} onRetry={retryAgg} />

      <PanelHeader title="Top of pile" subtitle="Where the pressure is concentrated" />
      <LeaderboardsPanel agg={agg} failed={aggFailed} onRetry={retryAgg} />

      <PanelHeader id="threats-table" innerRef={sliceRef} title="Slice" subtitle="Filter, sort, and inspect — click a row for the evidence behind the verdict" />
      <ThreatsTable
        columns={['type', 'target', 'brand', 'actor', 'technique', 'severity', 'status', 'evidence', 'last_seen']}
        rows={(data?.threats ?? []) as unknown as ThreatRow[]}
        total={data?.total ?? 0}
        loading={isLoading}
        state={table.state}
        pageSize={table.pageSize}
        onFilter={table.setFilter}
        onSearch={table.setSearch}
        onToggleSort={table.toggleSort}
        onPage={table.setPage}
        controls={['brand', 'severity', 'type', 'status', 'country', 'search']}
        brands={brandOpts}
        countries={countryOpts}
        sortKeys={{ type: 'type', target: 'target', brand: 'brand', severity: 'severity', status: 'status', last_seen: 'last_seen' }}
        renderExtraDetail={(r) => {
          const brandId = r.target_brand_id; const actorId = r.actor_id;
          const status = (r.status ?? '').toLowerCase();
          // Operator triage (admin-gated). Statuses mirror existing writers:
          // remediated (brand bulk-remediate), false_positive (curator), active.
          const transitions = isAdmin
            ? ([
                status !== 'remediated'     && { label: 'Mark remediated', to: 'remediated' },
                status !== 'false_positive' && { label: 'False positive',  to: 'false_positive' },
                status !== 'active'         && { label: 'Re-open',         to: 'active' },
              ].filter(Boolean) as Array<{ label: string; to: string }>)
            : [];
          if (!brandId && !actorId && transitions.length === 0) return null;
          return (
            <div className="thr-actions">
              {brandId && <button type="button" className="tt-link" onClick={() => navigate(`/brands/${brandId}`)}>↗ Brand</button>}
              {actorId && <button type="button" className="tt-link" onClick={() => navigate(tabUrl('actors', { focus: actorId }))}>↗ Threat actor</button>}
              {transitions.length > 0 && (
                <span className="thr-triage">
                  <span className="thr-label">Triage:</span>
                  {transitions.map(t => (
                    <KitButton
                      key={t.to}
                      variant="secondary"
                      size="sm"
                      onClick={() => updateThreat.mutate({ id: r.id, status: t.to })}
                      disabled={updateThreat.isPending}
                    >
                      {t.label}
                    </KitButton>
                  ))}
                </span>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}


// ── Slice summary strip ─────────────────────────────────────────
// One-line narrative summary of the current slice — answers
// "what am I looking at right now" before the operator scans rows.
function SliceSummaryStrip({ agg, hasFilters }: {
  agg: ReturnType<typeof useThreatAggregate>['data'];
  hasFilters: boolean;
}) {
  if (!agg) return null;
  const total = agg.total;
  if (total === 0) return null;
  const confirmedPct  = Math.round((agg.confirmed / total) * 100);
  const correlatedPct = Math.round((agg.correlated / total) * 100);
  const attributedPct = Math.round((agg.attributed / total) * 100);
  const addressedPct  = Math.round(agg.remediation_rate * 100);

  return (
    <div className="thr-strip thr-label thr-num" data-filtered={hasFilters}>
      <span>{hasFilters ? 'In slice:' : 'Across catalog:'}</span>
      <Stat label="Confirmed"  value={`${agg.confirmed.toLocaleString()} (${confirmedPct}%)`}  tone="info" />
      <Stat label="Correlated" value={`${agg.correlated.toLocaleString()} (${correlatedPct}%)`} tone="info" />
      <Stat label="Attributed" value={`${agg.attributed.toLocaleString()} (${attributedPct}%)`} tone="primary" />
      <Stat label="Addressed"  value={`${agg.addressed.toLocaleString()} (${addressedPct}%)`}  tone="ok" />
      {agg.new_24h > 0 && <Stat label="New 24h" value={agg.new_24h.toLocaleString()} tone="warn" />}
    </div>
  );
}

function Stat({ label, value, tone }: {
  label: string; value: string; tone: 'info' | 'primary' | 'ok' | 'warn';
}) {
  const color = tone === 'primary' ? 'var(--primary-text)'
    : tone === 'ok' ? 'var(--green-text)'
    : tone === 'warn' ? 'var(--sev-medium-text)'
    : 'var(--text-secondary)';
  return (
    <span className="flex items-center gap-1">
      <span>{label}</span>
      <span style={{ color }}>{value}</span>
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════
// HeroStrip — 4 Card hero tiles condensing the 6 narrative axes
// ══════════════════════════════════════════════════════════════════
function HeroStrip({ agg, failed }: { agg: ThreatAggregate | null | undefined; failed: boolean }) {
  const total = agg?.total ?? 0;
  const confirmedPct = total > 0 ? Math.round(((agg?.confirmed ?? 0) / total) * 100) : 0;
  const correlatedPct = total > 0 ? Math.round(((agg?.correlated ?? 0) / total) * 100) : 0;
  const attributedPct = total > 0 ? Math.round(((agg?.attributed ?? 0) / total) * 100) : 0;
  const addressedPct  = Math.round((agg?.remediation_rate ?? 0) * 100);

  const multiBrandCount = (agg?.multi_brand_campaigns?.length ?? 0)
    + (agg?.multi_brand_actors?.length ?? 0)
    + (agg?.multi_brand_providers?.length ?? 0);

  const tiles = [
    {
      icon: Activity,
      label: 'Active',
      value: (agg?.active ?? 0).toLocaleString(),
      sub: agg ? `${(agg.new_24h ?? 0).toLocaleString()} new in 24h` : '',
      accent: 'var(--red)',
    },
    {
      icon: ShieldCheck,
      label: 'Confirmed',
      value: `${confirmedPct}%`,
      sub: agg ? `${(agg.confirmed ?? 0).toLocaleString()} high-confidence` : '',
      accent: 'var(--blue)',
    },
    {
      icon: Network,
      label: 'Correlated',
      value: `${correlatedPct}%`,
      sub: agg ? `${(agg.correlated ?? 0).toLocaleString()} linked · ${multiBrandCount} multi-brand patterns` : '',
      accent: 'var(--primary)',
    },
    {
      icon: Users,
      label: 'Addressed',
      value: `${addressedPct}%`,
      sub: agg ? `${(agg.addressed ?? 0).toLocaleString()} of ${total.toLocaleString()} · ${attributedPct}% attributed` : '',
      accent: 'var(--green)',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map(t => {
        const Icon = t.icon;
        return (
          <Card key={t.label} variant={THREATS_CARD_VARIANT} aria-label={failed ? `${t.label}: couldn't load` : undefined}
            role={failed ? 'group' : undefined}
            style={{ padding: '18px 20px', minHeight: 110 }}>
            <div className="flex items-center gap-2 mb-2">
              <Icon size={14} style={{ color: accentText(t.accent) }} />
              <span className="thr-label">{sentenceCase(t.label)}</span>
            </div>
            <div className="thr-hero-value" style={{ color: accentText(t.accent) }}>
              {agg ? t.value : (failed ? '—' : '…')}
            </div>
            <div className="mt-1 thr-label thr-num truncate" style={{ color: 'var(--text-secondary)' }}>
              {failed ? "Couldn't load" : t.sub}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MultiBrandPanel — coordination signals
// ══════════════════════════════════════════════════════════════════
function AggregateState({ failed, onRetry, what }: { failed: boolean; onRetry: () => void; what: string }) {
  return failed
    ? <PageState kind="error" layout="card" compact title={`Couldn't load ${what}`} onRetry={onRetry} />
    : <PageState kind="loading" layout="card" title={`Loading ${what}…`} />;
}

/** A list row: a real button when it navigates (keyboard + focus ring), a plain div otherwise. */
function ListRow({ onClick, bordered, tight, children }: {
  onClick?: () => void; bordered?: boolean; tight?: boolean; children: ReactNode;
}) {
  const common = { className: 'thr-row', 'data-bordered': bordered ? 'true' : undefined, 'data-tight': tight ? 'true' : undefined };
  return onClick
    ? <button type="button" {...common} onClick={onClick}>{children}</button>
    : <div {...common}>{children}</div>;
}

function MultiBrandPanel({ agg, failed, onRetry }: { agg: ThreatAggregate | null | undefined; failed: boolean; onRetry: () => void }) {
  const campaigns = agg?.multi_brand_campaigns ?? [];
  const actors = agg?.multi_brand_actors ?? [];
  const providers = agg?.multi_brand_providers ?? [];
  const navigate = useNavigate();
  const allEmpty = campaigns.length === 0 && actors.length === 0 && providers.length === 0;

  if (!agg) return <AggregateState failed={failed} onRetry={onRetry} what="multi-brand patterns" />;
  if (allEmpty) {
    return (
      <Card variant={THREATS_CARD_VARIANT}>
        <div className="text-xs text-[var(--text-tertiary)] py-3">
          No multi-brand patterns in the current slice — every active threat targets a single brand.
        </div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      <MultiBrandCard
        title="Campaigns"
        accent="var(--primary)"
        rows={campaigns.map(c => ({
          id: c.id, name: c.name,
          tag: c.status,
          brand_count: c.brand_count,
          threat_count: c.threat_count,
          onClick: () => navigate(`/campaigns/${c.id}`),
        }))}
        emptyMsg="No multi-brand campaigns"
      />
      <MultiBrandCard
        title="Threat actors"
        accent="var(--red)"
        rows={actors.map(a => ({
          id: a.id, name: a.name,
          brand_count: a.brand_count,
          threat_count: a.threat_count,
          onClick: () => navigate(tabUrl('actors', { focus: a.id })),
        }))}
        emptyMsg="No actors hitting multiple brands"
      />
      <MultiBrandCard
        title="Hosting providers"
        accent="var(--blue)"
        rows={providers.map(p => ({
          id: p.id, name: p.name,
          tag: p.asn ?? undefined,
          brand_count: p.brand_count,
          threat_count: p.threat_count,
          onClick: () => navigate(tabUrl('providers', { focus: p.id })),
        }))}
        emptyMsg="No providers hosting multi-brand attacks"
      />
    </div>
  );
}

function MultiBrandCard({ title, accent, rows, emptyMsg }: {
  title: string;
  accent: string;
  rows: Array<{ id: string; name: string; tag?: string; brand_count: number; threat_count: number; onClick: () => void }>;
  emptyMsg: string;
}) {
  return (
    <Card variant={THREATS_CARD_VARIANT}>
      <h3 className="thr-label">{sentenceCase(title)}</h3>
      <div className="mt-2 space-y-1.5">
        {rows.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-2">{emptyMsg}</div>
        )}
        {rows.slice(0, 5).map(r => (
          <ListRow key={r.id} onClick={r.onClick} bordered>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {r.name}
                </div>
                <div className="thr-label thr-num">
                  {r.brand_count} brands · {r.threat_count} threats{r.tag ? ` · ${r.tag}` : ''}
                </div>
              </div>
              <span className="text-base font-bold flex-shrink-0 thr-num" style={{ color: accentText(accent) }}>
                {r.brand_count}
              </span>
            </div>
          </ListRow>
        ))}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// SurgingSignalsPanel — week-over-week deltas
// ══════════════════════════════════════════════════════════════════
function SurgingSignalsPanel({ agg, failed, onRetry }: { agg: ThreatAggregate | null | undefined; failed: boolean; onRetry: () => void }) {
  const navigate = useNavigate();
  const signals = agg?.surging_signals ?? [];
  if (!agg) return <AggregateState failed={failed} onRetry={onRetry} what="surging signals" />;
  if (signals.length === 0) {
    return (
      <Card variant={THREATS_CARD_VARIANT}>
        <div className="text-xs text-[var(--text-tertiary)] py-3">
          No surging signals this week. Catalog activity is steady.
        </div>
      </Card>
    );
  }
  const maxAbs = Math.max(1, ...signals.map(s => Math.abs(s.delta_pct)));

  return (
    <Card variant={THREATS_CARD_VARIANT}>
      <h3 className="thr-label">Surging this week vs last</h3>
      <div className="mt-3 space-y-1.5">
        {signals.map(s => {
          const isUp = s.delta_pct >= 0;
          const accent = isUp ? 'var(--red)' : 'var(--green)';
          const barW = (Math.abs(s.delta_pct) / maxAbs) * 100;
          const campaignId = s.kind === 'campaign' && s.id ? s.id : null;
          return (
            <ListRow key={`${s.kind}:${s.id ?? s.label}`} bordered
              onClick={campaignId ? () => navigate(`/campaigns/${campaignId}`) : undefined}>
              <div className="thr-bar" style={{
                width: `${barW}%`,
                background: `color-mix(in srgb, ${accent} 10%, transparent)`,
              }} />
              <div className="relative flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <TrendingUp size={12} style={{ color: accentText(accent), transform: isUp ? 'none' : 'rotate(180deg)' }} />
                  <span className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                    {s.label.replace(/_/g, ' ')}
                  </span>
                  <span className="thr-label">{s.kind}</span>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-bold thr-num" style={{ color: accentText(accent) }}>
                    {isUp ? '+' : ''}{s.delta_pct}%
                  </div>
                  <div className="thr-label thr-num">
                    {s.current_7d} vs {s.previous_7d}
                  </div>
                </div>
              </div>
            </ListRow>
          );
        })}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// LeaderboardsPanel — top brands / countries / providers / actors
// ══════════════════════════════════════════════════════════════════
function LeaderboardsPanel({ agg, failed, onRetry }: { agg: ThreatAggregate | null | undefined; failed: boolean; onRetry: () => void }) {
  const navigate = useNavigate();
  if (!agg) return failed ? <AggregateState failed onRetry={onRetry} what="leaderboards" /> : null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Leaderboard
        title="Top brands"
        accent="var(--primary)"
        rows={agg.top_brands.slice(0, 5).map(b => ({
          id: b.brand_id, label: b.brand_name, sub: b.canonical_domain,
          count: b.count, logoUrl: b.logo_url,
          onClick: () => navigate(`/brands/${b.brand_id}`),
        }))}
      />
      <Leaderboard
        title="Top providers"
        accent="var(--blue)"
        rows={agg.top_providers.slice(0, 5).map(p => ({
          id: p.provider_id, label: p.name, sub: p.asn ?? '',
          count: p.count,
          onClick: () => navigate(tabUrl('providers', { focus: p.provider_id })),
        }))}
      />
      <Leaderboard
        title="Top actors"
        accent="var(--red)"
        rows={agg.top_actors.slice(0, 5).map(a => ({
          id: a.actor_id, label: a.actor_name,
          count: a.count,
          onClick: () => navigate(tabUrl('actors', { focus: a.actor_id })),
        }))}
      />
      <Leaderboard
        title="Top countries"
        accent="var(--violet)"
        rows={agg.top_countries.slice(0, 5).map(c => ({
          id: c.country, label: c.country, count: c.count,
        }))}
      />
    </div>
  );
}

function Leaderboard({ title, accent, rows }: {
  title: string;
  accent: string;
  rows: Array<{ id: string; label: string; sub?: string; count: number; logoUrl?: string | null; onClick?: () => void }>;
}) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <Card variant={THREATS_CARD_VARIANT} style={{ minHeight: 200 }}>
      <h3 className="thr-label">{sentenceCase(title)}</h3>
      <div className="mt-2 space-y-1.5">
        {rows.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-2">No data</div>
        )}
        {rows.map(r => {
          const barW = (r.count / max) * 100;
          return (
            <ListRow key={r.id} onClick={r.onClick} tight>
              <div className="thr-bar" style={{
                width: `${barW}%`,
                background: `color-mix(in srgb, ${accent} 10%, transparent)`,
              }} />
              <div className="relative flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {r.label}
                  </div>
                  {r.sub && (
                    <div className="thr-label font-mono truncate">{r.sub}</div>
                  )}
                </div>
                <span className="text-xs font-bold flex-shrink-0 thr-num" style={{ color: accentText(accent) }}>
                  {r.count}
                </span>
              </div>
            </ListRow>
          );
        })}
      </div>
    </Card>
  );
}
