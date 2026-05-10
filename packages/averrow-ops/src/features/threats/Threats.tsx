import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { Card, DataRow, PageHeader, SaasTechniqueBadge } from '@/components/ui';
import { DeepCard } from '@/components/ui/DeepCard';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { ThreatInflowChart } from './ThreatInflowChart';
import { relativeTime } from '@/lib/time';
import { CheckCircle, Search, X, ShieldCheck, Network, Users, Activity, TrendingUp } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useThreatAggregate, type ThreatAggregateFilters, type ThreatAggregate } from '@/hooks/useThreatAggregate';
import type { Severity } from '@/components/ui/Badge';

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

function toSeverity(s: string | null): Severity | undefined {
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low' || s === 'info') return s;
  return undefined;
}

const STATUS_OPTIONS = ['active', 'down', 'remediated'] as const;
const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;
const SINCE_OPTIONS = [
  { value: '',       label: 'All time' },
  { value: '24h',    label: 'Last 24h' },
  { value: '7d',     label: 'Last 7d' },
  { value: '30d',    label: 'Last 30d' },
] as const;

// Convert UI date label to ISO since-string for the API
function sinceLabelToIso(label: string): string | undefined {
  if (!label) return undefined;
  const now = Date.now();
  const hours = label === '24h' ? 24 : label === '7d' ? 168 : label === '30d' ? 720 : 0;
  if (!hours) return undefined;
  return new Date(now - hours * 60 * 60_000).toISOString();
}

export function Threats() {
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [country, setCountry] = useState('');
  const [brandId, setBrandId] = useState('');
  const [actorId, setActorId] = useState('');
  const [sinceLabel, setSinceLabel] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const limit = 50;

  const filters: ThreatAggregateFilters = useMemo(() => ({
    severity: severity || undefined,
    type:     type || undefined,
    status:   status || undefined,
    country:  country || undefined,
    brand_id: brandId || undefined,
    actor_id: actorId || undefined,
    search:   search || undefined,
    since:    sinceLabelToIso(sinceLabel),
  }), [severity, type, status, country, brandId, actorId, search, sinceLabel]);

  // Aggregate fuels the slice-summary strip + populates the brand/actor/
  // country option lists from data the slice actually has.
  const { data: agg } = useThreatAggregate(filters);

  const { data, isLoading } = useQuery({
    queryKey: ['threats', filters, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(page * limit));
      if (filters.severity) params.set('severity', filters.severity);
      if (filters.type)     params.set('type',     filters.type);
      if (filters.status)   params.set('status',   filters.status);
      if (filters.search)   params.set('q',        filters.search);
      // brand/actor/country filters not yet wired into /api/threats list
      // backend — they'd require a small handleListThreats extension.
      // PR17 surfaces them in the aggregate; PR18 wires the list query.
      const res = await api.get<{ threats: Threat[]; total: number }>(`/api/threats?${params}`);
      if (!res.success || !res.data) throw new Error(res.error ?? 'Failed');
      return res.data;
    },
  });

  const totalForPagination = data?.total ?? 0;

  function clearAll() {
    setSeverity(''); setType(''); setStatus(''); setCountry('');
    setBrandId(''); setActorId(''); setSinceLabel(''); setSearch('');
    setPage(0);
  }

  const hasAnyFilter = !!(severity || type || status || country || brandId || actorId || sinceLabel || search);

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <PageHeader
        title="Threats"
        subtitle={agg ? `${agg.total.toLocaleString()} in slice · ${agg.active.toLocaleString()} active` : undefined}
      />

      <SliceSummaryStrip agg={agg} hasFilters={hasAnyFilter} />

      <HeroStrip agg={agg} />

      <ThreatInflowChart />

      <PanelHeader title="Coordination" subtitle="Patterns hitting multiple brands at once" />
      <MultiBrandPanel agg={agg} />

      <PanelHeader title="Evolving" subtitle="What's growing week-over-week" />
      <SurgingSignalsPanel agg={agg} />

      <PanelHeader title="Top of pile" subtitle="Where the pressure is concentrated" />
      <LeaderboardsPanel agg={agg} />

      <PanelHeader title="Slice" subtitle="Narrow the view to a specific axis" />
      <SlicersBar
        severity={severity}        setSeverity={(v) => { setSeverity(v); setPage(0); }}
        type={type}                setType={(v) => { setType(v); setPage(0); }}
        status={status}            setStatus={(v) => { setStatus(v); setPage(0); }}
        country={country}          setCountry={(v) => { setCountry(v); setPage(0); }}
        brandId={brandId}          setBrandId={(v) => { setBrandId(v); setPage(0); }}
        actorId={actorId}          setActorId={(v) => { setActorId(v); setPage(0); }}
        sinceLabel={sinceLabel}    setSinceLabel={(v) => { setSinceLabel(v); setPage(0); }}
        search={search}            setSearch={(v) => { setSearch(v); setPage(0); }}
        agg={agg}
      />

      {hasAnyFilter && <ActiveFilterChips
        severity={severity}    onClearSeverity={() => { setSeverity(''); setPage(0); }}
        type={type}            onClearType={() => { setType(''); setPage(0); }}
        status={status}        onClearStatus={() => { setStatus(''); setPage(0); }}
        country={country}      onClearCountry={() => { setCountry(''); setPage(0); }}
        brandId={brandId}      brandLabel={agg?.top_brands.find(b => b.brand_id === brandId)?.brand_name}
        onClearBrand={() => { setBrandId(''); setPage(0); }}
        actorId={actorId}      actorLabel={agg?.top_actors.find(a => a.actor_id === actorId)?.actor_name}
        onClearActor={() => { setActorId(''); setPage(0); }}
        sinceLabel={sinceLabel} onClearSince={() => { setSinceLabel(''); setPage(0); }}
        search={search}        onClearSearch={() => { setSearch(''); setPage(0); }}
        onClearAll={clearAll}
      />}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
        </div>
      ) : (
        <>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {(data?.threats ?? []).length === 0 ? (
              <EmptyState
                icon={hasAnyFilter ? <Search /> : <CheckCircle />}
                title={hasAnyFilter ? 'No threats match filters' : 'No active threats'}
                subtitle={hasAnyFilter
                  ? 'Try clearing some filters or widening the date range'
                  : 'All monitored brands are clean for this time window'}
                action={hasAnyFilter
                  ? { label: 'Clear filters', onClick: clearAll }
                  : undefined}
                variant="clean"
                compact
              />
            ) : (
              (data?.threats ?? []).map((t) => (
                <DataRow key={t.id} severity={toSeverity(t.severity)}>
                  <div className="grid grid-cols-[1fr_1.5fr_1fr_1fr_0.6fr_0.6fr_0.8fr] gap-3 items-center w-full font-mono text-[11px]">
                    <span style={{ color: 'var(--text-primary)' }}>{t.threat_type}</span>
                    <div className="flex flex-col gap-1 min-w-0">
                      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{t.malicious_domain ?? '-'}</span>
                      {t.saas_technique_id && t.saas_technique_name && t.saas_technique_phase && t.saas_technique_phase_label && (
                        <SaasTechniqueBadge
                          techniqueId={t.saas_technique_id}
                          techniqueName={t.saas_technique_name}
                          phase={t.saas_technique_phase}
                          phaseLabel={t.saas_technique_phase_label}
                          severity={t.saas_technique_severity ?? 'medium'}
                          size="xs"
                        />
                      )}
                    </div>
                    <span>
                      {t.target_brand_id ? (
                        <Link to={`/brands/${t.target_brand_id}`} className="hover:underline underline-offset-2" style={{ color: 'var(--text-primary)' }}>
                          {t.brand_name ?? t.target_brand_id}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </span>
                    <span>
                      {t.actor_id ? (
                        <Link to={`/threat-actors/${t.actor_id}`} className="hover:underline underline-offset-2" style={{ color: 'var(--amber)' }}>
                          {t.actor_name ?? 'Unknown Actor'}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>Unattributed</span>
                      )}
                    </span>
                    <span className="text-[10px] font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>
                      {t.severity ?? '-'}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{t.status}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{relativeTime(t.created_at)}</span>
                  </div>
                </DataRow>
              ))
            )}
          </Card>

          {totalForPagination > limit && (
            <div className="flex items-center gap-3 justify-center">
              <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
                className="font-mono text-[11px] disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-secondary)' }}>Prev</button>
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                Page {page + 1} of {Math.ceil(totalForPagination / limit)}
              </span>
              <button onClick={() => setPage(page + 1)} disabled={(page + 1) * limit >= totalForPagination}
                className="font-mono text-[11px] disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: 'var(--text-secondary)' }}>Next</button>
            </div>
          )}
        </>
      )}
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
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono px-3 py-2 rounded-md"
      style={{
        border: '1px solid var(--border-base)',
        background: hasFilters ? 'var(--sev-medium-bg, rgba(229,168,50,0.04))' : 'var(--bg-input)',
      }}
    >
      <span style={{ color: 'var(--text-tertiary)' }}>{hasFilters ? 'In slice:' : 'Across catalog:'}</span>
      <Stat label="Confirmed"  value={`${agg.confirmed.toLocaleString()} (${confirmedPct}%)`}  tone="info" />
      <Stat label="Correlated" value={`${agg.correlated.toLocaleString()} (${correlatedPct}%)`} tone="info" />
      <Stat label="Attributed" value={`${agg.attributed.toLocaleString()} (${attributedPct}%)`} tone="amber" />
      <Stat label="Addressed"  value={`${agg.addressed.toLocaleString()} (${addressedPct}%)`}  tone="ok" />
      {agg.new_24h > 0 && <Stat label="New 24h" value={agg.new_24h.toLocaleString()} tone="warn" />}
    </div>
  );
}

function Stat({ label, value, tone }: {
  label: string; value: string; tone: 'info' | 'amber' | 'ok' | 'warn';
}) {
  const color = tone === 'amber' ? 'var(--amber)'
    : tone === 'ok' ? 'var(--green)'
    : tone === 'warn' ? 'var(--sev-medium)'
    : 'var(--text-secondary)';
  return (
    <span className="flex items-center gap-1">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color }}>{value}</span>
    </span>
  );
}

// ── Slicers bar ────────────────────────────────────────────────
function SlicersBar(props: {
  severity: string; setSeverity: (v: string) => void;
  type: string;     setType: (v: string) => void;
  status: string;   setStatus: (v: string) => void;
  country: string;  setCountry: (v: string) => void;
  brandId: string;  setBrandId: (v: string) => void;
  actorId: string;  setActorId: (v: string) => void;
  sinceLabel: string; setSinceLabel: (v: string) => void;
  search: string;   setSearch: (v: string) => void;
  agg: ReturnType<typeof useThreatAggregate>['data'];
}) {
  // Populate option lists from the current aggregate so dropdowns
  // only show values that actually have data in the slice.
  const typeOptions = props.agg?.by_type ?? [];
  const countryOptions = props.agg?.top_countries ?? [];
  const brandOptions = props.agg?.top_brands ?? [];
  const actorOptions = props.agg?.top_actors ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2 p-2 rounded-md"
      style={{ border: '1px solid var(--border-base)', background: 'var(--bg-card)' }}>
      <Slicer label="Severity" value={props.severity} onChange={props.setSeverity}
        options={SEVERITY_OPTIONS.map(s => ({ value: s, label: s.toUpperCase() }))} />
      <Slicer label="Type" value={props.type} onChange={props.setType}
        options={typeOptions.map(t => ({ value: t.type, label: `${t.type.replace(/_/g,' ')} (${t.count})` }))} />
      <Slicer label="Status" value={props.status} onChange={props.setStatus}
        options={STATUS_OPTIONS.map(s => ({ value: s, label: s }))} />
      <Slicer label="Brand" value={props.brandId} onChange={props.setBrandId}
        options={brandOptions.map(b => ({ value: b.brand_id, label: `${b.brand_name} (${b.count})` }))} />
      <Slicer label="Actor" value={props.actorId} onChange={props.setActorId}
        options={actorOptions.map(a => ({ value: a.actor_id, label: `${a.actor_name} (${a.count})` }))} />
      <Slicer label="Country" value={props.country} onChange={props.setCountry}
        options={countryOptions.map(c => ({ value: c.country, label: `${c.country} (${c.count})` }))} />
      <Slicer label="Window" value={props.sinceLabel} onChange={props.setSinceLabel}
        options={SINCE_OPTIONS.filter(o => o.value !== '').map(o => ({ value: o.value, label: o.label }))} />
      <div className="flex items-center gap-2 ml-auto">
        <Search size={12} style={{ color: 'var(--text-muted)' }} />
        <input
          type="text"
          value={props.search}
          onChange={(e) => props.setSearch(e.target.value)}
          placeholder="Search domain / URL / IP"
          className="bg-transparent border-none outline-none text-[11px] font-mono"
          style={{ color: 'var(--text-primary)', width: 220 }}
        />
      </div>
    </div>
  );
}

function Slicer({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider"
      style={{ color: 'var(--text-muted)' }}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-[11px] font-mono px-1 py-0.5 rounded"
        style={{
          color: value ? 'var(--amber)' : 'var(--text-secondary)',
          border: '1px solid var(--border-base)',
          textTransform: 'none',
          letterSpacing: 0,
        }}
      >
        <option value="">All</option>
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ── Active filter chips ───────────────────────────────────────
function ActiveFilterChips(props: {
  severity: string; onClearSeverity: () => void;
  type: string;     onClearType: () => void;
  status: string;   onClearStatus: () => void;
  country: string;  onClearCountry: () => void;
  brandId: string;  brandLabel?: string; onClearBrand: () => void;
  actorId: string;  actorLabel?: string; onClearActor: () => void;
  sinceLabel: string; onClearSince: () => void;
  search: string;   onClearSearch: () => void;
  onClearAll: () => void;
}) {
  const chips: Array<{ label: string; onClear: () => void }> = [];
  if (props.severity)   chips.push({ label: `Severity: ${props.severity}`, onClear: props.onClearSeverity });
  if (props.type)       chips.push({ label: `Type: ${props.type.replace(/_/g, ' ')}`, onClear: props.onClearType });
  if (props.status)     chips.push({ label: `Status: ${props.status}`, onClear: props.onClearStatus });
  if (props.country)    chips.push({ label: `Country: ${props.country}`, onClear: props.onClearCountry });
  if (props.brandId)    chips.push({ label: `Brand: ${props.brandLabel ?? props.brandId}`, onClear: props.onClearBrand });
  if (props.actorId)    chips.push({ label: `Actor: ${props.actorLabel ?? props.actorId}`, onClear: props.onClearActor });
  if (props.sinceLabel) chips.push({ label: `Window: ${props.sinceLabel}`, onClear: props.onClearSince });
  if (props.search)     chips.push({ label: `Search: ${props.search}`, onClear: props.onClearSearch });
  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map(c => (
        <span key={c.label}
          className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded"
          style={{
            background: 'rgba(229,168,50,0.10)',
            color: 'var(--amber)',
            border: '1px solid rgba(229,168,50,0.30)',
          }}>
          <span>{c.label}</span>
          <button onClick={c.onClear}
            className="ml-1 hover:opacity-70 transition-opacity"
            aria-label={`Clear ${c.label}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      <button
        onClick={props.onClearAll}
        className="text-[10px] font-mono uppercase tracking-wider hover:opacity-80 ml-2"
        style={{ color: 'var(--text-tertiary)' }}
      >
        Clear all
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// PanelHeader — sectioned narrative dividers (matches /brands Intel)
// ══════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════
// HeroStrip — 4 DeepCard hero tiles condensing the 6 narrative axes
// ══════════════════════════════════════════════════════════════════
function HeroStrip({ agg }: { agg: ThreatAggregate | null | undefined }) {
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
      accent: '#C83C3C',
    },
    {
      icon: ShieldCheck,
      label: 'Confirmed',
      value: `${confirmedPct}%`,
      sub: agg ? `${(agg.confirmed ?? 0).toLocaleString()} high-confidence` : '',
      accent: '#0A8AB5',
    },
    {
      icon: Network,
      label: 'Correlated',
      value: `${correlatedPct}%`,
      sub: agg ? `${(agg.correlated ?? 0).toLocaleString()} linked · ${multiBrandCount} multi-brand patterns` : '',
      accent: '#E5A832',
    },
    {
      icon: Users,
      label: 'Addressed',
      value: `${addressedPct}%`,
      sub: agg ? `${(agg.addressed ?? 0).toLocaleString()} of ${total.toLocaleString()} · ${attributedPct}% attributed` : '',
      accent: '#3CB878',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map(t => {
        const Icon = t.icon;
        return (
          <DeepCard key={t.label} variant="active" accent={t.accent}
            style={{ padding: '18px 20px', position: 'relative', overflow: 'hidden', minHeight: 110 }}>
            <div style={{
              position: 'absolute', right: -20, bottom: -20,
              width: 110, height: 110, borderRadius: '50%',
              background: `radial-gradient(circle, ${t.accent}30, transparent 70%)`,
              pointerEvents: 'none',
            }} />
            <div style={{ position: 'relative' }}>
              <div className="flex items-center gap-2 mb-2">
                <Icon size={14} style={{ color: t.accent }} />
                <span className="text-[9px] font-mono uppercase tracking-[0.20em]" style={{ color: 'var(--text-tertiary)' }}>
                  {t.label}
                </span>
              </div>
              <div style={{
                fontSize: 30, fontWeight: 800, lineHeight: 1.05,
                color: t.accent, textShadow: `0 0 12px ${t.accent}55`,
              }}>
                {agg ? t.value : '…'}
              </div>
              <div className="mt-1 text-[11px] font-mono text-[var(--text-tertiary)] truncate">{t.sub}</div>
            </div>
          </DeepCard>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MultiBrandPanel — coordination signals
// ══════════════════════════════════════════════════════════════════
function MultiBrandPanel({ agg }: { agg: ThreatAggregate | null | undefined }) {
  const campaigns = agg?.multi_brand_campaigns ?? [];
  const actors = agg?.multi_brand_actors ?? [];
  const providers = agg?.multi_brand_providers ?? [];
  const navigate = useNavigate();
  const allEmpty = campaigns.length === 0 && actors.length === 0 && providers.length === 0;

  if (allEmpty) {
    return (
      <Card hover={false}>
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
        accent="#E5A832"
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
        accent="#C83C3C"
        rows={actors.map(a => ({
          id: a.id, name: a.name,
          brand_count: a.brand_count,
          threat_count: a.threat_count,
          onClick: () => navigate(`/threat-actors/${a.id}`),
        }))}
        emptyMsg="No actors hitting multiple brands"
      />
      <MultiBrandCard
        title="Hosting providers"
        accent="#0A8AB5"
        rows={providers.map(p => ({
          id: p.id, name: p.name,
          tag: p.asn ?? undefined,
          brand_count: p.brand_count,
          threat_count: p.threat_count,
          onClick: () => navigate(`/providers/${p.id}`),
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
    <Card hover={false}>
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-2 space-y-1.5">
        {rows.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-2">{emptyMsg}</div>
        )}
        {rows.slice(0, 5).map(r => (
          <div key={r.id}
            onClick={r.onClick}
            className="cursor-pointer hover:bg-white/[0.03] transition-colors"
            style={{
              padding: '8px 10px', borderRadius: 5,
              border: '1px solid var(--border-base)', background: 'var(--bg-input)',
            }}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                  {r.name}
                </div>
                <div className="text-[10px] font-mono text-[var(--text-tertiary)]">
                  {r.brand_count} brands · {r.threat_count} threats{r.tag ? ` · ${r.tag}` : ''}
                </div>
              </div>
              <span className="text-base font-bold flex-shrink-0" style={{ color: accent }}>
                {r.brand_count}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ══════════════════════════════════════════════════════════════════
// SurgingSignalsPanel — week-over-week deltas
// ══════════════════════════════════════════════════════════════════
function SurgingSignalsPanel({ agg }: { agg: ThreatAggregate | null | undefined }) {
  const signals = agg?.surging_signals ?? [];
  if (signals.length === 0) {
    return (
      <Card hover={false}>
        <div className="text-xs text-[var(--text-tertiary)] py-3">
          No surging signals this week. Catalog activity is steady.
        </div>
      </Card>
    );
  }
  const maxAbs = Math.max(1, ...signals.map(s => Math.abs(s.delta_pct)));
  const navigate = useNavigate();

  return (
    <Card hover={false}>
      <SectionLabel>Surging this week vs last</SectionLabel>
      <div className="mt-3 space-y-1.5">
        {signals.map(s => {
          const isUp = s.delta_pct >= 0;
          const accent = isUp ? '#C83C3C' : '#3CB878';
          const barW = (Math.abs(s.delta_pct) / maxAbs) * 100;
          const clickable = s.kind === 'campaign' && s.id;
          return (
            <div key={`${s.kind}:${s.id ?? s.label}`}
              onClick={() => clickable && navigate(`/campaigns/${s.id}`)}
              className={clickable ? 'cursor-pointer hover:bg-white/[0.03] transition-colors' : ''}
              style={{
                padding: '8px 10px', borderRadius: 5,
                position: 'relative', overflow: 'hidden',
                border: '1px solid var(--border-base)', background: 'var(--bg-input)',
              }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${barW}%`,
                background: `linear-gradient(90deg, ${accent}1a, transparent)`,
              }} />
              <div className="relative flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <TrendingUp size={12} style={{ color: accent, transform: isUp ? 'none' : 'rotate(180deg)' }} />
                  <span className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                    {s.label.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--text-muted)]">
                    {s.kind}
                  </span>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-bold" style={{ color: accent }}>
                    {isUp ? '+' : ''}{s.delta_pct}%
                  </div>
                  <div className="text-[10px] font-mono text-[var(--text-tertiary)]">
                    {s.current_7d} vs {s.previous_7d}
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

// ══════════════════════════════════════════════════════════════════
// LeaderboardsPanel — top brands / countries / providers / actors
// ══════════════════════════════════════════════════════════════════
function LeaderboardsPanel({ agg }: { agg: ThreatAggregate | null | undefined }) {
  if (!agg) return null;
  const navigate = useNavigate();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <Leaderboard
        title="Top brands"
        accent="#E5A832"
        rows={agg.top_brands.slice(0, 5).map(b => ({
          id: b.brand_id, label: b.brand_name, sub: b.canonical_domain,
          count: b.count, logoUrl: b.logo_url,
          onClick: () => navigate(`/brands/${b.brand_id}`),
        }))}
      />
      <Leaderboard
        title="Top providers"
        accent="#0A8AB5"
        rows={agg.top_providers.slice(0, 5).map(p => ({
          id: p.provider_id, label: p.name, sub: p.asn ?? '',
          count: p.count,
          onClick: () => navigate(`/providers/${p.provider_id}`),
        }))}
      />
      <Leaderboard
        title="Top actors"
        accent="#C83C3C"
        rows={agg.top_actors.slice(0, 5).map(a => ({
          id: a.actor_id, label: a.actor_name,
          count: a.count,
          onClick: () => navigate(`/threat-actors/${a.actor_id}`),
        }))}
      />
      <Leaderboard
        title="Top countries"
        accent="#9B59B6"
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
    <Card hover={false} style={{ minHeight: 200 }}>
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-2 space-y-1.5">
        {rows.length === 0 && (
          <div className="text-xs text-[var(--text-tertiary)] py-2">No data</div>
        )}
        {rows.map(r => {
          const barW = (r.count / max) * 100;
          return (
            <div key={r.id}
              onClick={r.onClick}
              className={r.onClick ? 'cursor-pointer hover:bg-white/[0.03] transition-colors' : ''}
              style={{
                padding: '6px 8px', borderRadius: 5,
                position: 'relative', overflow: 'hidden',
              }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${barW}%`,
                background: `linear-gradient(90deg, ${accent}1a, transparent)`,
              }} />
              <div className="relative flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {r.label}
                  </div>
                  {r.sub && (
                    <div className="text-[10px] font-mono text-[var(--text-tertiary)] truncate">{r.sub}</div>
                  )}
                </div>
                <span className="text-xs font-bold flex-shrink-0" style={{ color: accent }}>
                  {r.count}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
