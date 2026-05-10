import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import { Card, DataRow, PageHeader, SaasTechniqueBadge } from '@/components/ui';
import { ThreatInflowChart } from './ThreatInflowChart';
import { relativeTime } from '@/lib/time';
import { CheckCircle, Search, X } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useThreatAggregate, type ThreatAggregateFilters } from '@/hooks/useThreatAggregate';
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
    <div className="p-6 space-y-4 max-w-7xl">
      <PageHeader
        title="Threats"
        subtitle={agg ? `${agg.total.toLocaleString()} in slice · ${agg.active.toLocaleString()} active` : undefined}
      />

      <SliceSummaryStrip agg={agg} hasFilters={hasAnyFilter} />

      <ThreatInflowChart />

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
