// Takedowns — tenant-facing list of automated + staffed takedown
// requests issued on the customer's behalf, scoped to their org.
//
// 4-card headline + filterable list. Click-through to a detail
// route showing the submission audit trail.
//
// Phase C sprint 4.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, ShieldCheck, Send, Check, type LucideIcon } from 'lucide-react';
import {
  useTenantTakedowns,
  takedownActionsFor,
  STATUS_LABELS,
  MODULE_LABELS,
  type TakedownListRow,
  type TakedownTotals,
  type TakedownsFilters,
} from '@/lib/takedowns';
import { useCanTriage } from '@/lib/alerts';
import { TakedownActions } from './TakedownActions';

export function Takedowns() {
  const [filters, setFilters] = useState<TakedownsFilters>({});
  const { data, isLoading, error } = useTenantTakedowns(filters);
  const canTriage = useCanTriage();

  const update = (patch: Partial<TakedownsFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO OVERVIEW
      </Link>

      <header>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-[28px] font-bold text-white tracking-tight">Takedowns</h1>
        </div>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Submission requests issued to providers on your behalf. Drafts await analyst approval; approved requests are submitted under your signed authorization. Status, provider, and response audit trail per request.
        </p>
      </header>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading takedowns…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load takedowns</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <HeadlineMetrics totals={data.totals} />
          <FilterBar filters={filters} update={update} />
          {data.takedowns.length === 0 ? (
            <EmptyState filtered={Object.values(filters).some(Boolean)} />
          ) : (
            <TakedownsList rows={data.takedowns} canTriage={canTriage} />
          )}
        </>
      )}
    </div>
  );
}

function HeadlineMetrics({ totals }: { totals: TakedownTotals }) {
  const cards: Array<{
    label: string; value: number; sub: string;
    icon: LucideIcon; tone: 'crit' | 'warn' | 'ok' | 'neutral';
  }> = [
    {
      label: 'Total',
      value: totals.total,
      sub: 'across all statuses',
      icon: ShieldCheck,
      tone: 'neutral',
    },
    {
      label: 'In flight',
      value: totals.active,
      sub: 'submitted or pending',
      icon: Send,
      tone: totals.active > 0 ? 'warn' : 'neutral',
    },
    {
      label: 'Taken down',
      value: totals.completed,
      sub: 'resolved successfully',
      icon: Check,
      tone: 'ok',
    },
    {
      label: 'Failed / expired',
      value: totals.failed_or_expired,
      sub: 'manual follow-up needed',
      icon: AlertTriangle,
      tone: totals.failed_or_expired > 0 ? 'crit' : 'neutral',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        const accent =
          c.tone === 'crit' ? 'text-sev-critical' :
          c.tone === 'warn' ? 'text-amber'        :
          c.tone === 'ok'   ? 'text-green/85'     :
                              'text-white/85';
        return (
          <div key={c.label} className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/40 mb-1">
              <Icon size={11} /><span className="truncate">{c.label}</span>
            </div>
            <div className={`text-3xl font-bold tabular-nums ${accent}`}>{c.value}</div>
            <p className="text-[11px] text-white/40 mt-1 leading-relaxed">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}

function FilterBar({
  filters, update,
}: {
  filters: TakedownsFilters;
  update:  (patch: Partial<TakedownsFilters>) => void;
}) {
  const pillOff = "text-white/55 bg-white/[0.04] border-white/[0.08] hover:border-white/[0.20]";
  const pillOn  = "text-amber bg-amber/[0.10] border-amber/[0.30]";
  const pill = (active: boolean) =>
    `inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-2 py-1 transition-colors cursor-pointer ${active ? pillOn : pillOff}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-mono text-white/30 mr-1">Status</span>
        <button type="button" className={pill(!filters.status)} onClick={() => update({ status: null })}>All</button>
        {(['draft', 'submitted', 'pending_response', 'taken_down', 'failed'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={pill(filters.status === s)}
            onClick={() => update({ status: filters.status === s ? null : s })}
          >
            {STATUS_LABELS[s] ?? s}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-mono text-white/30 mr-1">Module</span>
        <button type="button" className={pill(!filters.module)} onClick={() => update({ module: null })}>All</button>
        {(['domain', 'social', 'app_store', 'dark_web', 'trademark'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={pill(filters.module === m)}
            onClick={() => update({ module: filters.module === m ? null : m })}
          >
            {MODULE_LABELS[m] ?? m}
          </button>
        ))}
      </div>
    </div>
  );
}

function TakedownsList({ rows, canTriage }: { rows: TakedownListRow[]; canTriage: boolean }) {
  const pending = rows.filter((t) => t.status === 'draft').length;
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Requests <span className="text-white/30">({rows.length})</span>
        {canTriage && pending > 0 && (
          <span className="ml-2 text-amber/80 normal-case tracking-normal">· {pending} awaiting your approval</span>
        )}
      </h2>
      <div className="space-y-2">
        {rows.map((t) => <TakedownRow key={t.id} takedown={t} canTriage={canTriage} />)}
      </div>
    </section>
  );
}

function TakedownRow({ takedown: t, canTriage }: { takedown: TakedownListRow; canTriage: boolean }) {
  const sev = (t.severity ?? '').toLowerCase();
  const tone =
    sev          === 'critical'                          ? 'border-sev-critical/[0.30]' :
    t.status     === 'failed'   || t.status === 'expired' ? 'border-sev-critical/[0.30]' :
    sev          === 'high'                              ? 'border-amber/[0.30]'        :
                                                            'border-white/[0.06]';
  const actions = canTriage ? takedownActionsFor(t.status) : [];
  return (
    <div className={`rounded-xl border bg-bg-card transition-colors ${tone}`}>
      <Link
        to={`/takedowns/${t.id}`}
        className="block p-4 transition-colors hover:bg-white/[0.02] rounded-t-xl"
      >
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <SeverityPill level={t.severity} />
          <StatusPill status={t.status} />
          {t.module_key && <ModuleChip module_key={t.module_key} />}
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/40">
            {t.target_type}
          </span>
          {t.submission_count > 0 && (
            <span className="text-[10px] uppercase tracking-widest font-mono text-white/55">
              {t.submission_count} submission{t.submission_count === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="text-sm font-semibold text-white/90 truncate font-mono">{t.target_value}</div>
        <div className="text-[12px] text-white/55 mt-0.5">
          target brand: {t.brand_name ?? t.brand_id}
          {t.provider_name && (
            <>
              {' '}· provider: <span className="font-mono">{t.provider_name}</span>
            </>
          )}
        </div>

        {t.evidence_summary && (
          <p className="text-[12px] text-white/65 mt-2 line-clamp-2">{t.evidence_summary}</p>
        )}

        <div className="flex items-center gap-3 mt-3 text-[11px] font-mono text-white/40">
          <span>created {formatDate(t.created_at)}</span>
          {t.submitted_at && <span>· submitted {formatDate(t.submitted_at)}</span>}
          {t.resolved_at  && <span>· resolved {formatDate(t.resolved_at)}</span>}
        </div>
      </Link>

      {actions.length > 0 && (
        <TakedownActions takedownId={t.id} actions={actions} className="px-4 py-2.5 border-t border-white/[0.06]" />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'taken_down'                    ? 'text-green/85    bg-green/[0.06]    border-green/[0.15]' :
    status === 'failed' || status === 'expired' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    status === 'submitted' || status === 'pending_response' ? 'text-amber bg-amber/[0.10] border-amber/[0.20]' :
                                                 'text-white/55 bg-white/[0.04] border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function SeverityPill({ level }: { level: string }) {
  const norm = level.toLowerCase();
  const tone =
    norm === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
    norm === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.20]'        :
    norm === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.10]'        :
                          'text-white/55     bg-white/[0.04]        border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {level}
    </span>
  );
}

function ModuleChip({ module_key }: { module_key: string }) {
  return (
    <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-blue/85 bg-blue/[0.06] border border-blue/[0.15] rounded px-1.5 py-0.5">
      {MODULE_LABELS[module_key] ?? module_key}
    </span>
  );
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
      <p className="text-white/55 text-sm">
        {filtered ? 'No takedowns match the current filters.' : 'No takedowns issued for your org yet.'}
      </p>
      <p className="text-white/35 text-xs mt-1">
        {filtered
          ? 'Clear filters to see everything.'
          : 'Takedowns appear here as scanners detect threats and the platform issues requests on your behalf.'}
      </p>
    </div>
  );
}
