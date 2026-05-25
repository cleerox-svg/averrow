// Threats — org-wide threat records browser.
//
// The records view behind the Overview's per-brand threat counts. Lists
// individual rows from the production `threats` table across every brand
// the org owns, via GET /api/orgs/:orgId/threats. Brand / status /
// severity / type filters + free-text domain search + pagination.
//
// Reads ?brand= from the URL so the Overview brand rows can deep-link in
// pre-filtered. Defaults to status='active'.

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ShieldAlert, AlertTriangle, Globe, Search } from 'lucide-react';
import {
  useTenantThreats,
  THREAT_TYPE_LABELS,
  type Threat,
  type ThreatStatus,
  type ThreatSeverity,
  type ThreatType,
} from '@/lib/threats';
import { useTenantDashboard } from '@/lib/dashboard';

const PAGE_SIZE = 50;

const STATUS_TABS: Array<{ key: ThreatStatus | 'all'; label: string }> = [
  { key: 'active',     label: 'Active' },
  { key: 'down',       label: 'Down' },
  { key: 'remediated', label: 'Remediated' },
  { key: 'all',        label: 'All' },
];

const SEVERITY_CHIPS: Array<{ key: ThreatSeverity | 'all'; label: string }> = [
  { key: 'all',      label: 'All severities' },
  { key: 'critical', label: 'Critical' },
  { key: 'high',     label: 'High' },
  { key: 'medium',   label: 'Medium' },
  { key: 'low',      label: 'Low' },
];

const TYPE_CHIPS: Array<{ key: ThreatType | 'all'; label: string }> = [
  { key: 'all',                   label: 'All types' },
  { key: 'malware_distribution',  label: 'Malware' },
  { key: 'phishing',              label: 'Phishing' },
  { key: 'typosquatting',         label: 'Typosquatting' },
  { key: 'impersonation',         label: 'Impersonation' },
  { key: 'credential_harvesting', label: 'Credential harvesting' },
  { key: 'c2',                    label: 'C2' },
];

export function Threats() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: dashboard } = useTenantDashboard();

  const brandId = searchParams.get('brand') ?? '';
  const [status, setStatus] = useState<ThreatStatus | 'all'>('active');
  const [severity, setSeverity] = useState<ThreatSeverity | 'all'>('all');
  const [threatType, setThreatType] = useState<ThreatType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error, isFetching } = useTenantThreats({
    brandId: brandId || undefined,
    status,
    severity,
    threatType,
    q: search.trim() || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  // Any filter change resets pagination to the first page.
  const resetPage = () => setOffset(0);

  const setBrand = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('brand', id); else next.delete('brand');
    setSearchParams(next, { replace: true });
    resetPage();
  };

  const brands = dashboard?.brands ?? [];
  const total = data?.total ?? 0;
  const rows = data?.threats ?? [];
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Threats</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Every malicious domain, URL, and host attributed to your brands by the threat-intel feeds.
        </p>
      </header>

      {data && <StatRow data={data} />}

      <FilterBar
        brands={brands}
        brandId={brandId}
        onBrand={setBrand}
        status={status}
        onStatus={(s) => { setStatus(s); resetPage(); }}
        severity={severity}
        onSeverity={(s) => { setSeverity(s); resetPage(); }}
        threatType={threatType}
        onType={(t) => { setThreatType(t); resetPage(); }}
        search={search}
        onSearch={(v) => { setSearch(v); resetPage(); }}
      />

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading threats…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load threats</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && rows.length === 0 && !isLoading && (
        <div className="rounded-xl border border-white/[0.06] bg-bg-card p-8 text-center">
          <p className="text-white/55 text-sm">No threats match these filters.</p>
          <p className="text-white/35 text-xs mt-1">Try widening the status to "All" or clearing the brand filter.</p>
        </div>
      )}

      {data && rows.length > 0 && (
        <>
          <ThreatsTable rows={rows} />
          <Pagination
            from={from}
            to={to}
            total={total}
            busy={isFetching}
            canPrev={offset > 0}
            canNext={to < total}
            onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            onNext={() => setOffset(offset + PAGE_SIZE)}
          />
        </>
      )}
    </div>
  );
}

// ─── Stat row ──────────────────────────────────────────────────────

function StatRow({ data }: { data: NonNullable<ReturnType<typeof useTenantThreats>['data']> }) {
  const sevCount = (s: string) =>
    data.severity_breakdown.find((b) => b.severity === s)?.count ?? 0;

  const cards: Array<{ label: string; value: number; tone: 'crit' | 'warn' | 'neutral'; icon: typeof ShieldAlert }> = [
    { label: 'Matching threats', value: data.total, tone: data.total > 0 ? 'warn' : 'neutral', icon: ShieldAlert },
    { label: 'Critical', value: sevCount('critical'), tone: sevCount('critical') > 0 ? 'crit' : 'neutral', icon: AlertTriangle },
    { label: 'High', value: sevCount('high'), tone: sevCount('high') > 0 ? 'warn' : 'neutral', icon: AlertTriangle },
    { label: 'Types seen', value: data.type_breakdown.length, tone: 'neutral', icon: Globe },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        const accent =
          c.tone === 'crit' ? 'text-sev-critical' :
          c.tone === 'warn' ? 'text-amber'        :
                              'text-white/85';
        return (
          <div key={c.label} className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
              <Icon size={11} /><span className="truncate">{c.label}</span>
            </div>
            <div className={`text-3xl font-bold tabular-nums ${accent}`}>{c.value.toLocaleString()}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Filter bar ────────────────────────────────────────────────────

function FilterBar({
  brands, brandId, onBrand,
  status, onStatus,
  severity, onSeverity,
  threatType, onType,
  search, onSearch,
}: {
  brands: Array<{ id: string; name: string }>;
  brandId: string;
  onBrand: (id: string) => void;
  status: ThreatStatus | 'all';
  onStatus: (s: ThreatStatus | 'all') => void;
  severity: ThreatSeverity | 'all';
  onSeverity: (s: ThreatSeverity | 'all') => void;
  threatType: ThreatType | 'all';
  onType: (t: ThreatType | 'all') => void;
  search: string;
  onSearch: (v: string) => void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={brandId}
          onChange={(e) => onBrand(e.target.value)}
          className="rounded-lg bg-white/[0.03] border border-white/[0.08] focus:border-amber/[0.40] focus:outline-none px-3 py-1.5 text-[12px] text-white/90 font-mono"
        >
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onStatus(t.key)}
              className={chipClass(status === t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <label className="relative ml-auto">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/35" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search domain…"
            className="rounded-lg bg-white/[0.03] border border-white/[0.08] focus:border-amber/[0.40] focus:outline-none pl-8 pr-3 py-1.5 text-[12px] text-white/90 font-mono placeholder:text-white/30 w-48"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {SEVERITY_CHIPS.map((c) => (
          <button key={c.key} type="button" onClick={() => onSeverity(c.key)} className={chipClass(severity === c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {TYPE_CHIPS.map((c) => (
          <button key={c.key} type="button" onClick={() => onType(c.key)} className={chipClass(threatType === c.key)}>
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function chipClass(active: boolean): string {
  return [
    'text-[10px] uppercase tracking-widest font-mono rounded px-2 py-1 border transition-colors',
    active
      ? 'text-amber bg-amber/[0.10] border-amber/[0.30]'
      : 'text-white/55 bg-white/[0.03] border-white/[0.08] hover:text-white/85 hover:border-white/[0.18]',
  ].join(' ');
}

// ─── Table ─────────────────────────────────────────────────────────

function ThreatsTable({ rows }: { rows: Threat[] }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden">
      <table className="w-full text-[12px]">
        <thead className="border-b border-white/[0.06] bg-white/[0.02]">
          <tr className="text-left">
            <Th>Brand</Th>
            <Th>Type</Th>
            <Th>Domain / URL</Th>
            <Th>Severity</Th>
            <Th>Status</Th>
            <Th>Source</Th>
            <Th>Country</Th>
            <Th>Last seen</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-white/[0.03] last:border-b-0 hover:bg-white/[0.02]">
              <Td className="text-white/80">{r.brand_name}</Td>
              <Td><TypePill type={r.threat_type} /></Td>
              <Td className="font-mono max-w-[280px] truncate">
                <span className="text-white/90" title={r.malicious_url ?? r.malicious_domain ?? ''}>
                  {r.malicious_domain ?? r.malicious_url ?? <span className="text-white/30">—</span>}
                </span>
              </Td>
              <Td><SeverityPill severity={r.severity} /></Td>
              <Td><StatusPill status={r.status} /></Td>
              <Td className="text-white/55 font-mono text-[11px]">{r.source_feed.replace(/_/g, ' ')}</Td>
              <Td className="text-white/45 font-mono text-[11px]">{r.country_code ?? '—'}</Td>
              <Td className="text-white/45 font-mono text-[11px]">
                {r.last_seen ? new Date(r.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination({
  from, to, total, busy, canPrev, canNext, onPrev, onNext,
}: {
  from: number; to: number; total: number; busy: boolean;
  canPrev: boolean; canNext: boolean; onPrev: () => void; onNext: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-mono text-white/45 tabular-nums">
        {busy ? 'Loading…' : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={!canPrev || busy}
          className="text-[11px] uppercase tracking-widest font-mono text-white/55 hover:text-white/85 border border-white/[0.08] hover:border-white/[0.20] rounded px-3 py-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Prev
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext || busy}
          className="text-[11px] uppercase tracking-widest font-mono text-amber hover:text-amber border border-amber/[0.20] hover:border-amber/[0.40] bg-amber/[0.06] rounded px-3 py-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ─── Pills ─────────────────────────────────────────────────────────

function TypePill({ type }: { type: string }) {
  const label = THREAT_TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/70 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

function SeverityPill({ severity }: { severity: string }) {
  const sev = (severity ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {sev || 'info'}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'     ? 'text-sev-critical bg-sev-critical/[0.08] border-sev-critical/[0.16]' :
    status === 'remediated' ? 'text-green/80     bg-green/[0.10]        border-green/[0.20]'        :
                              'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {status}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-[10px] uppercase tracking-widest font-mono text-white/45 font-normal">{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
}
