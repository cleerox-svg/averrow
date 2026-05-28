// Dark Web Monitoring — primary tenant surface.
//
// Platform-standard table layout (mirrors ops Dark Web page and the
// rest of the customer module pages): page header, hero stat strip,
// source mix + severity mix sidecars, FilterBar, real table of
// mentions with sort + pagination.
//
// Replaces the prior 188-LOC per-brand card grid that hid source
// diversity and had no filters or sort.

import { Link } from 'react-router-dom';
import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  useDarkWebOrgMentions,
  useDarkWebModuleSummary,
  SOURCE_LABELS,
  type DarkWebMentionWithBrand,
  type DarkWebOrgMentionsParams,
  type DarkWebSortKey,
} from '@/lib/darkWebModule';

const PAGE_SIZE = 50;

const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',                label: 'All sources' },
  { value: 'pastebin',        label: 'Pastebin' },
  { value: 'telegram',        label: 'Telegram' },
  { value: 'ransomware_leak', label: 'Ransomware leak' },
  { value: 'hibp',            label: 'HIBP' },
];

const SEVERITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',         label: 'All severities' },
  { value: 'CRITICAL', label: 'Critical' },
  { value: 'HIGH',     label: 'High' },
  { value: 'MEDIUM',   label: 'Medium' },
  { value: 'LOW',      label: 'Low' },
];

const CLASSIFICATION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',               label: 'All classifications' },
  { value: 'confirmed',      label: 'Confirmed' },
  { value: 'suspicious',     label: 'Suspicious' },
  { value: 'unknown',        label: 'Unknown' },
  { value: 'false_positive', label: 'False positive' },
];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'active',         label: 'Active' },
  { value: 'investigating',  label: 'Investigating' },
  { value: 'resolved',       label: 'Resolved' },
  { value: 'false_positive', label: 'False positive' },
];

export function DarkWeb() {
  const { data: summary } = useDarkWebModuleSummary();
  const brandOpts = useMemo(() => (summary?.brands ?? []).map(b => ({
    value: b.brand_id, label: b.brand_name,
  })), [summary]);

  const [status,         setStatus]         = useState<string>('active');
  const [source,         setSource]         = useState<string>('');
  const [severity,       setSeverity]       = useState<string>('');
  const [classification, setClassification] = useState<string>('');
  const [brandId,        setBrandId]        = useState<string>('');
  const [q,              setQ]              = useState<string>('');
  const [sort,           setSort]           = useState<DarkWebSortKey>('last_seen');
  const [dir,            setDir]            = useState<'asc' | 'desc'>('desc');
  const [page,           setPage]           = useState(0);

  const params: DarkWebOrgMentionsParams = useMemo(() => ({
    status,
    source:         source         || undefined,
    severity:       severity       || undefined,
    classification: classification || undefined,
    brand_id:       brandId        || undefined,
    q:              q              || undefined,
    sort,
    dir,
    limit:  PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }), [status, source, severity, classification, brandId, q, sort, dir, page]);

  const query = useDarkWebOrgMentions(params);
  const data  = query.data;
  const rows  = data?.results ?? [];
  const total = data?.total ?? 0;
  const slice = data?.aggregates?.slice;
  const bySource = data?.aggregates?.by_source ?? [];
  const bySeverity = data?.aggregates?.by_severity ?? [];

  const toggleSort = useCallback((key: DarkWebSortKey) => {
    setPage(0);
    if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSort(key); setDir('desc'); }
  }, [sort]);

  const hasActiveFilters = !!(source || severity || classification || brandId || q);
  const resetFilters = useCallback(() => {
    setSource(''); setSeverity(''); setClassification(''); setBrandId(''); setQ(''); setPage(0);
  }, []);

  return (
    <div className="max-w-7xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-[28px] font-bold text-white tracking-tight">Dark Web Monitoring</h1>
          <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-amber bg-amber/[0.10] border border-amber/[0.20] rounded px-2 py-1">
            Active
          </span>
        </div>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Brand mentions, leaked credentials, and executive references across paste archives, Telegram leak channels, and ransomware leak sites.
        </p>
      </header>

      {query.error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load Dark Web Monitoring</h3>
          <p className="text-[12px] text-white/55 mt-1">{(query.error as Error).message}</p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Active mentions"     value={slice?.total_active ?? 0}                              accent="neutral" />
        <StatTile label="Confirmed leaks"     value={slice?.confirmed_active ?? 0}                          accent={(slice?.confirmed_active ?? 0) > 0 ? 'crit' : 'neutral'} />
        <StatTile label="Critical / High"     value={(slice?.critical_active ?? 0) + (slice?.high_active ?? 0)} accent={((slice?.critical_active ?? 0) + (slice?.high_active ?? 0)) > 0 ? 'warn' : 'neutral'} />
        <StatTile label="Sources active"      value={bySource.length}                                       accent={bySource.length > 1 ? 'warn' : 'neutral'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <SourceMixCard data={bySource} totalActive={slice?.total_active ?? 0} />
        <SeverityMixCard data={bySeverity} totalActive={slice?.total_active ?? 0} />
        <SearchAndScopeCard q={q} onQ={(v) => { setQ(v); setPage(0); }} hasFilters={hasActiveFilters} onReset={resetFilters} />
      </div>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card">
        <div className="p-3 flex items-center gap-2 flex-wrap border-b border-white/[0.06]">
          <FilterSelect label="Source"         value={source}         onChange={(v) => { setSource(v); setPage(0); }}         options={SOURCE_OPTIONS} />
          <FilterSelect label="Severity"       value={severity}       onChange={(v) => { setSeverity(v); setPage(0); }}       options={SEVERITY_OPTIONS} />
          <FilterSelect label="Classification" value={classification} onChange={(v) => { setClassification(v); setPage(0); }} options={CLASSIFICATION_OPTIONS} />
          <FilterSelect label="Status"         value={status}         onChange={(v) => { setStatus(v); setPage(0); }}         options={STATUS_OPTIONS} />
          {brandOpts.length > 1 && (
            <FilterSelect
              label="Brand"
              value={brandId}
              onChange={(v) => { setBrandId(v); setPage(0); }}
              options={[{ value: '', label: 'All brands' }, ...brandOpts]}
            />
          )}
          <div className="ml-auto font-mono text-[10px] text-white/40">
            {total.toLocaleString()} match{total === 1 ? '' : 'es'}
          </div>
        </div>

        {query.isLoading ? (
          <div className="text-white/40 text-sm font-mono py-12 text-center">Loading mentions…</div>
        ) : rows.length === 0 ? (
          <EmptyMentions hasFilters={hasActiveFilters || status !== 'active'} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <SortableTh label="Source"       sortKey="source"    current={sort} dir={dir} onClick={toggleSort} />
                    <SortableTh label="Severity"     sortKey="severity"  current={sort} dir={dir} onClick={toggleSort} />
                    <Th>Classification</Th>
                    <SortableTh label="Brand"        sortKey="brand"     current={sort} dir={dir} onClick={toggleSort} />
                    <Th className="min-w-[260px]">Mention</Th>
                    <Th>Channel</Th>
                    <SortableTh label="Last seen"    sortKey="last_seen" current={sort} dir={dir} onClick={toggleSort} className="text-right" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(m => (<MentionRow key={m.id} m={m} />))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPage={setPage}
            />
          </>
        )}
      </section>
    </div>
  );
}

// ─── UI sub-components ──────────────────────────────────────────

function StatTile({
  label, value, accent,
}: {
  label: string;
  value: number;
  accent: 'crit' | 'warn' | 'neutral';
}) {
  const color =
    accent === 'crit' ? 'text-sev-critical' :
    accent === 'warn' ? 'text-amber'        :
                        'text-white/85';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">{label}</div>
      <div className={`text-3xl font-bold tabular-nums ${color}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function SourceMixCard({ data, totalActive }: { data: Array<{ source: string; n: number }>; totalActive: number }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-3">Source mix</div>
      {data.length === 0 ? (
        <div className="text-white/40 text-xs">No mentions yet.</div>
      ) : (
        <div className="space-y-2">
          {data.map(d => {
            const pct = totalActive > 0 ? Math.round((d.n / totalActive) * 100) : 0;
            return (
              <div key={d.source}>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-white/85">{SOURCE_LABELS[d.source] ?? d.source}</span>
                  <span className="font-mono text-white/60 tabular-nums">{d.n.toLocaleString()} · {pct}%</span>
                </div>
                <div className="mt-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className="h-full bg-amber/70" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SeverityMixCard({ data, totalActive }: { data: Array<{ severity: string; n: number }>; totalActive: number }) {
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const map = new Map(data.map(d => [d.severity, d.n]));
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-3">Severity mix</div>
      {totalActive === 0 ? (
        <div className="text-white/40 text-xs">No mentions yet.</div>
      ) : (
        <div className="space-y-2">
          {order.map(sev => {
            const n = map.get(sev) ?? 0;
            const pct = totalActive > 0 ? Math.round((n / totalActive) * 100) : 0;
            const barColor =
              sev === 'CRITICAL' ? 'bg-sev-critical/70' :
              sev === 'HIGH'     ? 'bg-amber/70'        :
              sev === 'MEDIUM'   ? 'bg-amber/40'        :
                                   'bg-blue/60';
            return (
              <div key={sev}>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-white/85 uppercase tracking-wider font-mono text-[10px]">{sev}</span>
                  <span className="font-mono text-white/60 tabular-nums">{n.toLocaleString()} · {pct}%</span>
                </div>
                <div className="mt-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SearchAndScopeCard({
  q, onQ, hasFilters, onReset,
}: { q: string; onQ: (v: string) => void; hasFilters: boolean; onReset: () => void }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-3">Search & scope</div>
      <input
        type="text"
        value={q}
        onChange={e => onQ(e.target.value)}
        placeholder="Search snippet, channel, brand…"
        className="w-full h-9 px-3 rounded-lg bg-black/30 border border-white/[0.08] text-sm text-white/90 placeholder:text-white/35 focus:border-amber/40 focus:outline-none"
      />
      {hasFilters && (
        <button
          type="button"
          onClick={onReset}
          className="mt-3 text-[11px] font-mono text-amber hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-white/40">
      <span>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-7 px-2 rounded bg-black/30 border border-white/[0.08] text-[11px] text-white/85 font-mono focus:border-amber/40 focus:outline-none"
      >
        {options.map(o => (
          <option key={o.value} value={o.value} className="bg-bg-card">{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2.5 text-left font-mono text-[11px] uppercase tracking-wider text-white/40 border-b border-white/[0.06] ${className}`}>
      {children}
    </th>
  );
}

function SortableTh({
  label, sortKey, current, dir, onClick, className,
}: {
  label: string;
  sortKey: DarkWebSortKey;
  current: DarkWebSortKey;
  dir: 'asc' | 'desc';
  onClick: (k: DarkWebSortKey) => void;
  className?: string;
}) {
  const active = current === sortKey;
  return (
    <Th className={className}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-white/85 ${active ? 'text-amber' : ''}`}
      >
        <span>{label}</span>
        {active && <span className="text-[9px]">{dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </Th>
  );
}

function MentionRow({ m }: { m: DarkWebMentionWithBrand }) {
  const snippet = (m.content_snippet ?? '').trim();
  return (
    <tr className="hover:bg-white/[0.02]">
      <td className="px-3 py-2.5 border-b border-white/[0.03]">
        <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/70 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
          {SOURCE_LABELS[m.source] ?? m.source}
        </span>
      </td>
      <td className="px-3 py-2.5 border-b border-white/[0.03]">
        <SeverityPill level={m.severity} />
      </td>
      <td className="px-3 py-2.5 border-b border-white/[0.03]">
        <ClassificationPill classification={m.classification} />
      </td>
      <td className="px-3 py-2.5 border-b border-white/[0.03]">
        {m.brand_id ? (
          <Link to={`/modules/dark-web/brands/${m.brand_id}`} className="text-left hover:text-amber">
            <div className="text-sm text-white/90">{m.brand_name ?? m.brand_id}</div>
            {m.brand_domain && <div className="font-mono text-[10px] text-white/45">{m.brand_domain}</div>}
          </Link>
        ) : (
          <span className="text-white/40 text-xs">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 border-b border-white/[0.03]">
        {snippet ? (
          <div className="text-[12px] text-white/75 line-clamp-2 font-mono leading-relaxed max-w-[420px]">
            {snippet}
          </div>
        ) : (
          <span className="text-white/35 text-xs">no snippet</span>
        )}
        {m.classification_reason && (
          <div className="text-[10px] text-white/40 mt-1 italic line-clamp-1">{m.classification_reason}</div>
        )}
      </td>
      <td className="px-3 py-2.5 border-b border-white/[0.03]">
        {m.source_channel ? (
          <span className="font-mono text-[11px] text-white/65">{m.source_channel}</span>
        ) : (
          <span className="text-white/30 text-xs">—</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right border-b border-white/[0.03]">
        <div className="font-mono text-[11px] text-white/55">
          {formatRel(m.last_seen ?? m.first_seen ?? null)}
        </div>
        {m.source_url && (
          <a
            href={m.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-1 text-[10px] text-amber hover:underline"
          >
            <ExternalLink size={10} /> source
          </a>
        )}
      </td>
    </tr>
  );
}

function SeverityPill({ level }: { level: string }) {
  const sev = (level ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {level}
    </span>
  );
}

function ClassificationPill({ classification }: { classification: string }) {
  const tone =
    classification === 'confirmed'      ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    classification === 'suspicious'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    classification === 'false_positive' ? 'text-white/40     bg-white/[0.04]        border-white/[0.08]'        :
    classification === 'resolved'       ? 'text-white/55     bg-white/[0.06]        border-white/[0.10]'        :
                                          'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {classification}
    </span>
  );
}

function EmptyMentions({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="text-center py-16 px-6">
      <p className="text-white/65 text-sm">
        {hasFilters ? 'No mentions match these filters.' : 'No active dark web mentions for your brands yet.'}
      </p>
      <p className="text-white/40 text-xs mt-2 max-w-md mx-auto">
        {hasFilters
          ? 'Clear filters to see all active mentions.'
          : 'The dark web monitor scans every 6 hours. New findings appear here as paste archives, Telegram leak channels, and ransomware leak sites are processed.'}
      </p>
    </div>
  );
}

function Pagination({
  page, pageSize, total, onPage,
}: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  if (lastPage === 0) return null;
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="px-4 py-2.5 flex items-center justify-between font-mono text-[11px] text-white/55 border-t border-white/[0.06]">
      <div>Showing {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}</div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPage(Math.max(0, page - 1))}
          disabled={page === 0}
          className="px-2 py-1 rounded border border-white/[0.08] hover:bg-white/[0.04] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Prev
        </button>
        <span className="px-2">{page + 1} / {lastPage + 1}</span>
        <button
          type="button"
          onClick={() => onPage(Math.min(lastPage, page + 1))}
          disabled={page === lastPage}
          className="px-2 py-1 rounded border border-white/[0.08] hover:bg-white/[0.04] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function formatRel(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
