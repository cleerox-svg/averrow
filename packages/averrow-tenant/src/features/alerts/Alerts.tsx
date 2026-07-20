// Tenant Alerts inbox.
//
// Labelled "Alerts" platform-wide (owner decision, 2026-07). The
// underlying table is still `alerts` and the API path is still
// `/api/orgs/:orgId/alerts` — those are structural identifiers and
// stay as-is; only the display label changed.
//
// Shows brand alerts across the org's brands with severity + status
// pills. Backed by GET /api/orgs/:orgId/alerts.
//
// Analysts (org role analyst+) can drive the status lifecycle inline —
// acknowledge / investigate / resolve / false-positive — via
// PATCH /api/orgs/:orgId/alerts/:alertId. Viewers see the queue
// read-only. (Phase 1, TENANT_ANALYST_UX_RESEARCH_2026-06 §6.)

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ShieldCheck, Bell, Check, UserPlus, Loader2, X, Filter, type LucideIcon } from 'lucide-react';
import {
  useTenantAlerts, useCanTriage, useBulkUpdateAlerts, extractConfidence,
  type Alert, type AlertSeverity, type AlertStatus,
} from '@/lib/alerts';
import { useAuth } from '@/lib/auth';
import { AlertActions, AssigneeControl } from './AlertActions';
import { AiAssessmentPanel } from './AiAssessment';
import { AgePill } from '@/components/AgePill';
import { cn } from '@/lib/cn';

const PAGE_SIZE = 50;

type SeverityFilter = AlertSeverity | 'all';
type StatusFilter   = AlertStatus | 'all';

const SEVERITY_OPTIONS: Array<{ key: SeverityFilter; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'high',     label: 'High' },
  { key: 'medium',   label: 'Medium' },
  { key: 'low',      label: 'Low' },
];

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all',           label: 'All' },
  { key: 'new',           label: 'New' },
  { key: 'acknowledged',  label: 'Acknowledged' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'resolved',      label: 'Resolved' },
];

export function Alerts() {
  // Incoming deep-link filters — e.g. the executives registry links here
  // as `/alerts?brand=<brandId>&type=executive_impersonation` ("view this
  // brand's executive-impersonation alerts"). Fixed for the session; not
  // exposed as its own picker UI, just a dismissible chip, since these two
  // params only ever arrive via a deep link, never a user click in this
  // page. Per-executive scoping isn't possible — the alerts API has no
  // executive_id filter (only brand_id / alert_type) — so this is
  // brand-wide for that alert type, not exec-specific.
  const [searchParams, setSearchParams] = useSearchParams();
  const brandFilter = searchParams.get('brand') ?? undefined;
  const typeFilter   = searchParams.get('type') ?? undefined;
  const clearDeepLinkFilter = () => setSearchParams({});

  const [severity, setSeverityState] = useState<SeverityFilter>('all');
  const [status, setStatusState]     = useState<StatusFilter>('new');
  const [page, setPage]              = useState(0);
  const [selected, setSelected]      = useState<Set<string>>(new Set());
  const { data, isLoading, error } = useTenantAlerts({
    severity, status, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    brandId: brandFilter, alertType: typeFilter,
  });
  const canTriage = useCanTriage();

  const clearSelection = () => setSelected(new Set());

  // Changing a filter/page resets to the first page and drops the selection
  // so the pager never strands an out-of-range offset and we never act on
  // ids that are no longer on screen.
  const setSeverity = (v: SeverityFilter) => { setSeverityState(v); setPage(0); clearSelection(); };
  const setStatus   = (v: StatusFilter)   => { setStatusState(v);   setPage(0); clearSelection(); };
  const goPage      = (p: number)         => { setPage(p); clearSelection(); };

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const pageIds = data?.alerts.map((a) => a.id) ?? [];
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectedIds = pageIds.filter((id) => selected.has(id));

  return (
    <div className="max-w-6xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-white/55">
          Brand alerts — impersonations, typosquats, email security drift, dark-web mentions. Sorted by severity, then recency.
        </p>
      </header>

      {(brandFilter || typeFilter) && (
        <div className="inline-flex items-center gap-2 rounded-lg border border-amber/[0.25] bg-amber/[0.06] px-3 py-1.5 text-[12px] text-amber/90">
          <Filter size={12} />
          <span>
            Filtered{typeFilter && <> · {typeFilter.replace(/_/g, ' ')}</>}{brandFilter && <> · this brand</>}
          </span>
          <button
            type="button"
            onClick={clearDeepLinkFilter}
            className="inline-flex items-center gap-1 text-white/60 hover:text-white/90"
            aria-label="Clear filter"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {data && <SeverityRollup breakdown={data.severity_breakdown} />}

      <div className="space-y-3">
        <FilterBar label="Severity" options={SEVERITY_OPTIONS} value={severity} onChange={setSeverity} />
        <FilterBar label="Status"   options={STATUS_OPTIONS}   value={status}   onChange={setStatus} />
      </div>

      {isLoading && <Loading />}
      {error    && <ErrorState error={error.message} />}

      {data && (
        data.alerts.length === 0 ? (
          <EmptyState status={status} severity={severity} />
        ) : (
          <section className="space-y-3">
            {canTriage && (
              <BulkToolbar
                allSelected={allSelected}
                onToggleAll={() => setSelected(allSelected ? new Set() : new Set(pageIds))}
                selectedIds={selectedIds}
                onClear={clearSelection}
              />
            )}
            {data.alerts.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                canTriage={canTriage}
                selected={selected.has(a.id)}
                onToggleSelect={canTriage ? toggle : undefined}
              />
            ))}
            <Pager page={page} pageSize={PAGE_SIZE} shown={data.alerts.length} total={data.total} onPage={goPage} />
          </section>
        )
      )}
    </div>
  );
}

// Multi-select bulk triage bar (analyst+). Applies to the currently-selected
// signals on this page via the bulk endpoint.
function BulkToolbar({
  allSelected, onToggleAll, selectedIds, onClear,
}: {
  allSelected: boolean;
  onToggleAll: () => void;
  selectedIds: string[];
  onClear: () => void;
}) {
  const { user } = useAuth();
  const bulk = useBulkUpdateAlerts();
  const me = user?.id ?? null;
  const n = selectedIds.length;

  const run = (args: { status?: 'acknowledged' | 'resolved'; assignedTo?: string }) =>
    bulk.mutate({ alertIds: selectedIds, ...args }, { onSuccess: onClear });

  const btn = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-50 bg-white/[0.04] text-white/65 border-white/[0.08] hover:text-white/95 hover:border-white/[0.18]';

  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg border border-white/[0.07] bg-bg-card px-3 py-2">
      <label className="inline-flex items-center gap-2 text-[11px] font-mono text-white/55 cursor-pointer select-none">
        <input type="checkbox" checked={allSelected} onChange={onToggleAll} className="accent-amber w-3.5 h-3.5" />
        Select all on page
      </label>
      {n > 0 && (
        <>
          <span className="text-[11px] font-mono text-amber/90">· {n} selected</span>
          <div className="flex items-center gap-1.5 ml-1">
            <button type="button" disabled={bulk.isPending} onClick={() => run({ status: 'acknowledged' })} className={btn}><Check size={11} /> Acknowledge</button>
            <button type="button" disabled={bulk.isPending} onClick={() => run({ status: 'resolved' })} className={btn}><ShieldCheck size={11} /> Resolve</button>
            {me && <button type="button" disabled={bulk.isPending} onClick={() => run({ assignedTo: me })} className={btn}><UserPlus size={11} /> Assign to me</button>}
            <button type="button" disabled={bulk.isPending} onClick={onClear} className={btn}><X size={11} /> Clear</button>
            {bulk.isPending && <Loader2 size={13} className="text-white/40 animate-spin" />}
          </div>
        </>
      )}
      {bulk.isError && (
        <span className="text-[11px] text-sev-critical">{bulk.error instanceof Error ? bulk.error.message : 'Bulk action failed'}</span>
      )}
    </div>
  );
}

function SeverityRollup({
  breakdown,
}: {
  breakdown: Array<{ severity: AlertSeverity; count: number }>;
}) {
  const counts: Record<AlertSeverity, number> = {
    critical: 0, high: 0, medium: 0, low: 0,
  };
  // Defensive: the DB has historically mixed case for alert
  // severity (lowercase in alerts/threats, uppercase in module
  // tables). Normalise so the rollup is robust to either.
  for (const b of breakdown) {
    const key = (b.severity ?? '').toLowerCase() as AlertSeverity;
    if (key in counts) counts[key] = b.count;
  }
  const total = counts.critical + counts.high + counts.medium + counts.low;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <RollupCard label="Total" value={total} icon={Bell} tone="neutral" />
      <RollupCard label="Critical" value={counts.critical} icon={AlertTriangle} tone={counts.critical > 0 ? 'crit' : 'neutral'} />
      <RollupCard label="High" value={counts.high} icon={AlertTriangle} tone={counts.high > 0 ? 'warn' : 'neutral'} />
      <RollupCard label="Resolved-able" value={counts.medium + counts.low} icon={ShieldCheck} tone="neutral" />
    </div>
  );
}

function RollupCard({
  label, value, icon: Icon, tone,
}: {
  label: string; value: number;
  icon: LucideIcon;
  tone: 'neutral' | 'warn' | 'crit';
}) {
  const accent =
    tone === 'crit' ? 'text-sev-critical' :
    tone === 'warn' ? 'text-amber'        :
                      'text-white/85';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
        <Icon size={11} /><span>{label}</span>
      </div>
      <div className={`text-3xl font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

function FilterBar<T extends string>({
  label, options, value, onChange,
}: {
  label: string;
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-widest font-mono text-white/35 mr-1">{label}</span>
      {options.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={cn(
            'px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors',
            value === opt.key
              ? 'bg-amber/[0.10] text-amber border-amber/[0.30]'
              : 'bg-white/[0.04] text-white/55 border-white/[0.08] hover:text-white/85',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ai_recommendations is sometimes a JSON-encoded array (["...","..."]),
// sometimes a plain string. Parse to a clean list either way so we never
// dump a raw bracketed array at the user.
function parseRecommendations(raw: string | null): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* fall through to plain text */ }
  }
  return [t];
}

function AlertRow({ alert: a, canTriage, selected, onToggleSelect }: {
  alert: Alert; canTriage: boolean; selected?: boolean; onToggleSelect?: (id: string) => void;
}) {
  const sev = (a.severity ?? '').toLowerCase();
  const accent =
    sev === 'critical' ? 'border-l-sev-critical/70' :
    sev === 'high'     ? 'border-l-amber/70'        :
    sev === 'medium'   ? 'border-l-amber/40'        :
                         'border-l-white/15';
  const recs = parseRecommendations(a.ai_recommendations);
  return (
    <article className={`rounded-xl border border-white/[0.07] border-l-2 ${accent} bg-bg-card p-4 hover:border-white/[0.16] transition-colors`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={!!selected}
              onChange={() => onToggleSelect(a.id)}
              className="accent-amber w-3.5 h-3.5 flex-shrink-0"
              aria-label="Select signal"
            />
          )}
          <SeverityPill level={a.severity} />
          <ConfidencePill value={extractConfidence(a.details)} />
          <StatusPill status={a.status} />
          {a.status !== 'resolved' && a.status !== 'false_positive' && (
            <AgePill createdAt={a.created_at} severity={a.severity} />
          )}
          <span className="text-[10px] font-mono text-white/40 uppercase tracking-wider">
            {a.alert_type.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <AssigneeControl alert={a} canTriage={canTriage} />
          <div className="text-right text-[10px] font-mono text-white/40">
            <div>{new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            <div className="mt-0.5 truncate max-w-[140px] text-white/55">{a.brand_name}</div>
          </div>
        </div>
      </div>

      <h3 className="text-[15px] font-semibold mt-2 leading-snug">
        <Link to={`/alerts/${a.id}`} className="text-white/90 hover:text-amber transition-colors">{a.title}</Link>
      </h3>
      {a.summary && <p className="text-[12px] text-white/55 mt-1 leading-relaxed">{a.summary}</p>}
      <AiAssessmentPanel raw={a.ai_assessment} />
      {recs.length > 0 && <Recommendations items={recs} />}
      {a.resolution_notes && (a.status === 'resolved' || a.status === 'false_positive') && (
        <p className="text-[11px] text-white/45 mt-2 italic">
          <span className="not-italic font-mono uppercase tracking-wider text-white/35">note · </span>
          {a.resolution_notes}
        </p>
      )}
      {canTriage && <AlertActions alert={a} />}
    </article>
  );
}

function Recommendations({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, 2);
  return (
    <div className="mt-3 rounded-lg border border-amber/[0.16] bg-amber/[0.04] px-3 py-2.5">
      <div className="text-[9px] uppercase tracking-[0.18em] font-mono text-amber/70 mb-1.5">Recommended actions</div>
      <ul className="space-y-1.5">
        {shown.map((r, i) => (
          <li key={i} className="flex gap-2 text-[11.5px] text-white/70 leading-relaxed">
            <span className="text-amber/60 flex-shrink-0 mt-[2px]">▸</span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
      {items.length > 2 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-2 text-[10px] font-mono uppercase tracking-widest text-amber/70 hover:text-amber"
        >
          {open ? 'show less' : `+${items.length - 2} more`}
        </button>
      )}
    </div>
  );
}

function SeverityPill({ level }: { level: AlertSeverity | string }) {
  const sev = (level ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {sev}
    </span>
  );
}

function StatusPill({ status }: { status: AlertStatus }) {
  const tone =
    status === 'new'           ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    status === 'acknowledged'  ? 'text-white/70     bg-white/[0.06]        border-white/[0.10]'        :
    status === 'investigating' ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
    status === 'resolved'      ? 'text-white/40     bg-white/[0.04]        border-white/[0.08]'        :
                                 'text-white/40     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

// Detection confidence, shown distinct from severity (severity = how bad if
// real; confidence = how sure the detection is). Rendered only when the alert
// carries a structured score; absent for feed/campaign alerts.
function ConfidencePill({ value }: { value: number | null }) {
  if (value === null) return null;
  const tone =
    value >= 80 ? 'text-blue/90 bg-blue/[0.08] border-blue/[0.22]' :
    value >= 50 ? 'text-blue/70 bg-blue/[0.05] border-blue/[0.15]' :
                  'text-white/50 bg-white/[0.04] border-white/[0.08]';
  return (
    <span
      title="Detection confidence"
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}
    >
      {value}% conf
    </span>
  );
}

function Pager({
  page, pageSize, shown, total, onPage,
}: {
  page: number; pageSize: number; shown: number; total: number; onPage: (p: number) => void;
}) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = page * pageSize + shown;
  const hasPrev = page > 0;
  const hasNext = end < total;
  if (!hasPrev && !hasNext) {
    return (
      <p className="text-[11px] text-white/40 font-mono text-center pt-2">
        {total} signal{total === 1 ? '' : 's'}
      </p>
    );
  }
  const btn = 'px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-default bg-white/[0.04] text-white/60 border-white/[0.08] enabled:hover:text-white/90 enabled:hover:border-white/[0.18]';
  return (
    <div className="flex items-center justify-between pt-2">
      <span className="text-[11px] text-white/40 font-mono">showing {start}–{end} of {total}</span>
      <div className="flex items-center gap-1.5">
        <button type="button" className={btn} disabled={!hasPrev} onClick={() => onPage(page - 1)}>Prev</button>
        <button type="button" className={btn} disabled={!hasNext} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

function EmptyState({ status, severity }: { status: StatusFilter; severity: SeverityFilter }) {
  const filtersOn = status !== 'new' || severity !== 'all';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-8 text-center">
      <ShieldCheck size={28} className="mx-auto text-white/30 mb-2" />
      <p className="text-sm text-white/70">
        {filtersOn ? 'No signals match these filters.' : 'No new signals.'}
      </p>
      <p className="text-[11px] text-white/40 mt-1">
        {filtersOn ? 'Try widening severity or status.' : 'You\'re caught up. New brand signals will land here.'}
      </p>
    </div>
  );
}

function Loading() {
  return <div className="text-white/40 text-sm font-mono py-12 text-center">Loading signals…</div>;
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
      <h3 className="text-sm font-semibold text-white/90">Couldn't load signals</h3>
      <p className="text-[12px] text-white/55 mt-1">{error}</p>
    </div>
  );
}
