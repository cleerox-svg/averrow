// Tenant Alerts inbox.
//
// Shows alerts across the org's brands with severity + status pills.
// Backed by GET /api/orgs/:orgId/alerts.
//
// Phase B sprint 2 — viewer-only for now. Mutations (acknowledge,
// resolve, false-positive) port in subsequent sprints once the
// per-alert detail page lands.

import { useState } from 'react';
import { AlertTriangle, ShieldCheck, Bell, type LucideIcon } from 'lucide-react';
import { useTenantAlerts, type Alert, type AlertSeverity, type AlertStatus } from '@/lib/alerts';
import { cn } from '@/lib/cn';

type SeverityFilter = AlertSeverity | 'all';
type StatusFilter   = AlertStatus | 'all';

const SEVERITY_OPTIONS: Array<{ key: SeverityFilter; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'CRITICAL', label: 'Critical' },
  { key: 'HIGH',     label: 'High' },
  { key: 'MEDIUM',   label: 'Medium' },
  { key: 'LOW',      label: 'Low' },
];

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all',           label: 'All' },
  { key: 'new',           label: 'New' },
  { key: 'acknowledged',  label: 'Acknowledged' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'resolved',      label: 'Resolved' },
];

export function Alerts() {
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [status, setStatus]     = useState<StatusFilter>('new');
  const { data, isLoading, error } = useTenantAlerts({ severity, status });

  return (
    <div className="max-w-6xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-white/55">
          Action-required findings for your brands. Sorted by severity, then recency.
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
            {data.alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
            {data.total > data.alerts.length && (
              <p className="text-[11px] text-white/40 font-mono text-center pt-2">
                showing {data.alerts.length} of {data.total} · paginate further coming soon
              </p>
            )}
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
    CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0,
  };
  for (const b of breakdown) counts[b.severity] = b.count;
  const total = counts.CRITICAL + counts.HIGH + counts.MEDIUM + counts.LOW;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <RollupCard label="Total" value={total} icon={Bell} tone="neutral" />
      <RollupCard label="Critical" value={counts.CRITICAL} icon={AlertTriangle} tone={counts.CRITICAL > 0 ? 'crit' : 'neutral'} />
      <RollupCard label="High" value={counts.HIGH} icon={AlertTriangle} tone={counts.HIGH > 0 ? 'warn' : 'neutral'} />
      <RollupCard label="Resolved-able" value={counts.MEDIUM + counts.LOW} icon={ShieldCheck} tone="neutral" />
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

function AlertRow({ alert: a }: { alert: Alert }) {
  const tone =
    a.severity === 'CRITICAL' ? 'border-sev-critical/[0.30]' :
    a.severity === 'HIGH'     ? 'border-amber/[0.30]'        :
                                'border-white/[0.06]';
  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <SeverityPill level={a.severity} />
            <StatusPill status={a.status} />
            <span className="text-[10px] font-mono text-white/40 uppercase tracking-wider">
              {a.alert_type.replace(/_/g, ' ')}
            </span>
          </div>
          <h3 className="text-sm font-semibold text-white/90">{a.title}</h3>
          <p className="text-[12px] text-white/55 mt-1 leading-relaxed">{a.summary}</p>
        </div>
        <div className="text-right text-[10px] font-mono text-white/40 flex-shrink-0">
          <div>{new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
          <div className="mt-0.5 truncate max-w-[140px]">{a.brand_name}</div>
        </div>
      </div>

      {a.ai_recommendations && (
        <p className="text-[11px] text-amber/80 mt-2 font-mono">
          → {a.ai_recommendations}
        </p>
      )}
    </article>
  );
}

function SeverityPill({ level }: { level: AlertSeverity }) {
  const tone =
    level === 'CRITICAL' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    level === 'HIGH'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    level === 'MEDIUM'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                           'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {level}
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

function EmptyState({ status, severity }: { status: StatusFilter; severity: SeverityFilter }) {
  const filtersOn = status !== 'new' || severity !== 'all';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-8 text-center">
      <ShieldCheck size={28} className="mx-auto text-white/30 mb-2" />
      <p className="text-sm text-white/70">
        {filtersOn ? 'No alerts match these filters.' : 'No new alerts.'}
      </p>
      <p className="text-[11px] text-white/40 mt-1">
        {filtersOn ? 'Try widening severity or status.' : 'You\'re caught up. New findings will land here.'}
      </p>
    </div>
  );
}

function Loading() {
  return <div className="text-white/40 text-sm font-mono py-12 text-center">Loading alerts…</div>;
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
      <h3 className="text-sm font-semibold text-white/90">Couldn't load alerts</h3>
      <p className="text-[12px] text-white/55 mt-1">{error}</p>
    </div>
  );
}
