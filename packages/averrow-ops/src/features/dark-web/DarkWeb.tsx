// Averrow — Dark Web (cross-brand mention table)
//
// Platform-standard table layout matching /threats and /providers:
//   - PageHeader with slice totals
//   - StatGrid hero strip (total / confirmed / critical+high / source diversity)
//   - SliceSummary: source mix + severity mix sidecars
//   - FilterBar (source / severity / classification / status / search)
//   - Real <Table> of mentions with sort, pagination, source column,
//     brand column, severity pill, classification pill, snippet preview,
//     channel, last seen
//
// Replaces the prior 132-LOC card grid that lacked filters, sort,
// pagination, source column, and a real table.

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  useDarkWebAllMentions,
  type DarkWebAllMentionsParams,
  type DarkWebClassification,
  type DarkWebMentionWithBrand,
  type DarkWebSortKey,
  type DarkWebStatus,
  type Severity,
} from '@/hooks/useDarkWebMonitor';
import { Card, PageHeader, StatCard, StatGrid } from '@/components/ui';
import { Table, Th, Td } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { relativeTime } from '@/lib/time';

const PAGE_SIZE = 50;

const SOURCE_LABELS: Record<string, string> = {
  pastebin:        'Pastebin',
  telegram:        'Telegram leak channel',
  ransomware_leak: 'Ransomware leak site',
  hibp:            'HIBP',
  flare:           'Flare',
  darkowl:         'DarkOwl',
};

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

function formatCount(n: number): string {
  return n.toLocaleString();
}

function severityRank(sev: string | null | undefined): number {
  switch ((sev ?? '').toUpperCase()) {
    case 'CRITICAL': return 4;
    case 'HIGH':     return 3;
    case 'MEDIUM':   return 2;
    case 'LOW':      return 1;
    default:         return 0;
  }
}

export function DarkWeb() {
  const navigate = useNavigate();
  const [status,         setStatus]         = useState<DarkWebStatus>('active');
  const [source,         setSource]         = useState<string>('');
  const [severity,       setSeverity]       = useState<string>('');
  const [classification, setClassification] = useState<string>('');
  const [q,              setQ]              = useState<string>('');
  const [sort,           setSort]           = useState<DarkWebSortKey>('last_seen');
  const [dir,            setDir]            = useState<'asc' | 'desc'>('desc');
  const [page,           setPage]           = useState(0);

  const params: DarkWebAllMentionsParams = useMemo(() => ({
    status,
    source:         source || undefined,
    severity:       (severity || undefined) as Severity | undefined,
    classification: (classification || undefined) as DarkWebClassification | undefined,
    q:              q || undefined,
    sort,
    dir,
    limit:  PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }), [status, source, severity, classification, q, sort, dir, page]);

  const query = useDarkWebAllMentions(params);
  const data = query.data;
  const rows = data?.results ?? [];
  const total = data?.total ?? 0;
  const slice = data?.aggregates?.slice;
  const bySource = data?.aggregates?.by_source ?? [];
  const bySeverity = data?.aggregates?.by_severity ?? [];

  const toggleSort = useCallback((key: DarkWebSortKey) => {
    setPage(0);
    if (sort === key) {
      setDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(key);
      setDir('desc');
    }
  }, [sort]);

  const resetFilters = useCallback(() => {
    setSource(''); setSeverity(''); setClassification(''); setQ(''); setPage(0);
  }, []);
  const hasActiveFilters = !!(source || severity || classification || q);

  const goToBrand = (brandId: string | null) => {
    if (brandId) navigate(`/brands/${brandId}?tab=dark-web`);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dark Web"
        subtitle={`${formatCount(slice?.total_active ?? 0)} active mentions across paste archives, Telegram leak channels, and ransomware leak sites`}
      />

      <StatGrid>
        <StatCard
          label="Active Mentions"
          value={formatCount(slice?.total_active ?? 0)}
          accentColor="var(--red)"
        />
        <StatCard
          label="Confirmed"
          value={formatCount(slice?.confirmed_active ?? 0)}
          accentColor={(slice?.confirmed_active ?? 0) > 0 ? 'var(--red)' : 'var(--blue)'}
        />
        <StatCard
          label="Critical / High"
          value={formatCount((slice?.critical_active ?? 0) + (slice?.high_active ?? 0))}
          accentColor={
            (slice?.critical_active ?? 0) + (slice?.high_active ?? 0) > 0
              ? 'var(--red)' : 'var(--blue)'
          }
        />
        <StatCard
          label="Sources Active"
          value={formatCount(bySource.length)}
          accentColor={bySource.length > 1 ? 'var(--amber)' : 'var(--blue)'}
        />
      </StatGrid>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SourceMixCard data={bySource} totalActive={slice?.total_active ?? 0} />
        <SeverityMixCard data={bySeverity} totalActive={slice?.total_active ?? 0} />
        <SearchAndScopeCard q={q} onQ={(v) => { setQ(v); setPage(0); }} hasFilters={hasActiveFilters} onReset={resetFilters} />
      </div>

      <Card>
        <div className="p-3 flex items-center gap-2 flex-wrap border-b border-white/[0.06]">
          <FilterSelect label="Source"         value={source}         onChange={(v) => { setSource(v); setPage(0); }}         options={SOURCE_OPTIONS} />
          <FilterSelect label="Severity"       value={severity}       onChange={(v) => { setSeverity(v); setPage(0); }}       options={SEVERITY_OPTIONS} />
          <FilterSelect label="Classification" value={classification} onChange={(v) => { setClassification(v); setPage(0); }} options={CLASSIFICATION_OPTIONS} />
          <FilterSelect label="Status"         value={status}         onChange={(v) => { setStatus(v as DarkWebStatus); setPage(0); }} options={STATUS_OPTIONS} />
          <div className="ml-auto font-mono text-[10px] text-white/40">
            {formatCount(total)} match{total === 1 ? '' : 'es'}
          </div>
        </div>

        {query.isLoading ? (
          <div className="text-center text-white/40 font-mono text-xs py-12">Loading mentions…</div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={hasActiveFilters || status !== 'active' ? 'No mentions match these filters' : 'No dark web mentions yet'}
            subtitle={
              hasActiveFilters || status !== 'active'
                ? 'Clear filters to see all active mentions.'
                : 'The dark web monitor scans every 6 hours. New findings appear here as paste archives, Telegram leak channels, and ransomware leak sites are processed.'
            }
            variant="scanning"
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <SortableTh label="Source"  sortKey="source"    current={sort} dir={dir} onClick={toggleSort} />
                  <SortableTh label="Severity" sortKey="severity"  current={sort} dir={dir} onClick={toggleSort} />
                  <Th>Classification</Th>
                  <SortableTh label="Brand"   sortKey="brand"     current={sort} dir={dir} onClick={toggleSort} />
                  <Th className="min-w-[260px]">Mention</Th>
                  <Th>Channel</Th>
                  <SortableTh label="Last Seen" sortKey="last_seen" current={sort} dir={dir} onClick={toggleSort} className="text-right" />
                </tr>
              </thead>
              <tbody>
                {rows.map(m => (
                  <MentionRow key={m.id} m={m} onBrandClick={() => goToBrand(m.brand_id)} />
                ))}
              </tbody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────

function SourceMixCard({ data, totalActive }: { data: Array<{ source: string; n: number }>; totalActive: number }) {
  return (
    <Card>
      <div className="p-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-3">Source mix · all active</div>
        {data.length === 0 ? (
          <div className="text-white/40 text-xs">No mentions ingested yet.</div>
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
    </Card>
  );
}

function SeverityMixCard({ data, totalActive }: { data: Array<{ severity: string; n: number }>; totalActive: number }) {
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const map = new Map(data.map(d => [d.severity, d.n]));
  return (
    <Card>
      <div className="p-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-white/40 mb-3">Severity mix · all active</div>
        {totalActive === 0 ? (
          <div className="text-white/40 text-xs">No mentions ingested yet.</div>
        ) : (
          <div className="space-y-2">
            {order.map(sev => {
              const n = map.get(sev) ?? 0;
              const pct = totalActive > 0 ? Math.round((n / totalActive) * 100) : 0;
              const barColor =
                sev === 'CRITICAL' ? 'bg-sev-critical/70' :
                sev === 'HIGH'     ? 'bg-sev-high/70' :
                sev === 'MEDIUM'   ? 'bg-amber/60' :
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
    </Card>
  );
}

function SearchAndScopeCard({
  q, onQ, hasFilters, onReset,
}: {
  q: string;
  onQ: (v: string) => void;
  hasFilters: boolean;
  onReset: () => void;
}) {
  return (
    <Card>
      <div className="p-4">
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
    </Card>
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

function MentionRow({ m, onBrandClick }: { m: DarkWebMentionWithBrand; onBrandClick: () => void }) {
  const snippet = (m.content_snippet ?? '').trim();
  return (
    <tr className="hover:bg-white/[0.02]">
      <Td>
        <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/70 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
          {SOURCE_LABELS[m.source] ?? m.source}
        </span>
      </Td>
      <Td>
        <SeverityPill level={m.severity} />
      </Td>
      <Td>
        <ClassificationPill classification={m.classification} />
      </Td>
      <Td>
        {m.brand_id ? (
          <button
            type="button"
            onClick={onBrandClick}
            className="text-left hover:text-amber"
          >
            <div className="text-sm text-white/90">{m.brand_name ?? m.brand_id}</div>
            {m.brand_domain && <div className="font-mono text-[10px] text-white/45">{m.brand_domain}</div>}
          </button>
        ) : (
          <span className="text-white/40 text-xs">—</span>
        )}
      </Td>
      <Td>
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
      </Td>
      <Td>
        {m.source_channel ? (
          <span className="font-mono text-[11px] text-white/65">{m.source_channel}</span>
        ) : (
          <span className="text-white/30 text-xs">—</span>
        )}
      </Td>
      <Td className="text-right">
        <div className="font-mono text-[11px] text-white/55">
          {m.last_seen ? relativeTime(m.last_seen) : m.first_seen ? relativeTime(m.first_seen) : '—'}
        </div>
        {m.source_url && (
          <a
            href={m.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-1 text-[10px] text-amber hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={10} /> source
          </a>
        )}
      </Td>
    </tr>
  );
}

function SeverityPill({ level }: { level: string }) {
  const sev = (level ?? '').toLowerCase();
  const variant: 'critical' | 'high' | 'default' =
    sev === 'critical' ? 'critical' :
    sev === 'high'     ? 'high'     :
                         'default';
  // Badge uses 'critical' / 'high' variants — map MEDIUM/LOW to default with text accent.
  if (sev === 'medium' || sev === 'low') {
    return (
      <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 text-amber/85 bg-amber/[0.06] border-amber/[0.15]">
        {level}
      </span>
    );
  }
  return <Badge variant={variant}>{level}</Badge>;
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

function Pagination({
  page, pageSize, total, onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
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

// keep severityRank exported so the hook + page can share if needed later
export { severityRank };
