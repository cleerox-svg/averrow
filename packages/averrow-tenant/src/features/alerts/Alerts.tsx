// Tenant Signals inbox.
//
// NX3: this page was previously labelled "Alerts". The underlying
// table is still `alerts` (rename deferred to NXF1) and the API path
// is still `/api/orgs/:orgId/alerts` — only the user-facing language
// is "Signals" on the tenant side, reflecting the conceptual model
// that these are brand-signals belonging to the tenant, not ops alerts.
//
// Shows brand signals across the org's brands with severity + status
// pills. Backed by GET /api/orgs/:orgId/alerts.
//
// Analysts (org role analyst+) can drive the status lifecycle inline —
// acknowledge / investigate / resolve / false-positive — via
// PATCH /api/orgs/:orgId/alerts/:alertId. Viewers see the queue
// read-only. (Phase 1, TENANT_ANALYST_UX_RESEARCH_2026-06 §6.)

import { useState } from 'react';
import { AlertTriangle, ShieldCheck, Bell, type LucideIcon } from 'lucide-react';
import {
  useTenantAlerts, useCanTriage, extractConfidence,
  type Alert, type AlertSeverity, type AlertStatus,
} from '@/lib/alerts';
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
  const [severity, setSeverityState] = useState<SeverityFilter>('all');
  const [status, setStatusState]     = useState<StatusFilter>('new');
  const [page, setPage]              = useState(0);
  const { data, isLoading, error } = useTenantAlerts({ severity, status, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const canTriage = useCanTriage();

  // Changing a filter resets to the first page so the pager never strands
  // the user on an out-of-range offset.
  const setSeverity = (v: SeverityFilter) => { setSeverityState(v); setPage(0); };
  const setStatus   = (v: StatusFilter)   => { setStatusState(v);   setPage(0); };

  return (
    <div className="max-w-6xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Signals</h1>
        <p className="mt-1 text-sm text-white/55">
          Brand signals — impersonations, typosquats, email security drift, dark-web mentions. Sorted by severity, then recency.
        </p>
      </header>

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
            {data.alerts.map((a) => <AlertRow key={a.id} alert={a} canTriage={canTriage} />)}
            <Pager page={page} pageSize={PAGE_SIZE} shown={data.alerts.length} total={data.total} onPage={setPage} />
          </section>
        )
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

function AlertRow({ alert: a, canTriage }: { alert: Alert; canTriage: boolean }) {
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

      <h3 className="text-[15px] font-semibold text-white/90 mt-2 leading-snug">{a.title}</h3>
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
