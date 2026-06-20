// Takedown detail — full request metadata + submission audit
// trail (one row per dispatch attempt, including follow-ups).
//
// Phase C sprint 4.

import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Mail, FileText } from 'lucide-react';
import {
  useTenantTakedownDetail,
  takedownActionsFor,
  STATUS_LABELS,
  MODULE_LABELS,
  SUBMITTER_KIND_LABELS,
  type TakedownDetailRow,
  type TakedownSubmissionAuditRow,
} from '@/lib/takedowns';
import { useCanTriage } from '@/lib/alerts';
import { TakedownActions } from './TakedownActions';

export function TakedownDetail() {
  const { takedownId } = useParams<{ takedownId: string }>();
  const { data, isLoading, error } = useTenantTakedownDetail(takedownId ?? null);
  const canTriage = useCanTriage();

  return (
    <div className="max-w-6xl space-y-6">
      <Link to="/takedowns" className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70">
        <ArrowLeft size={12} /> BACK TO TAKEDOWNS
      </Link>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading takedown…</div>}
      {error && (
        <div className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <h3 className="text-sm font-semibold text-white/90">Couldn't load takedown</h3>
          <p className="text-[12px] text-white/55 mt-1">{error.message}</p>
        </div>
      )}

      {data && (
        <>
          <Header takedown={data.takedown} />
          {canTriage && takedownActionsFor(data.takedown.status).length > 0 && (
            <section className="rounded-xl border border-amber/[0.20] bg-amber/[0.04] p-4">
              <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-amber/70 mb-2">Your decision</div>
              <p className="text-[12px] text-white/60 mb-3">
                Review the evidence below, then approve to submit this request to the provider, or withdraw to decline it.
              </p>
              <TakedownActions takedownId={data.takedown.id} actions={takedownActionsFor(data.takedown.status)} />
            </section>
          )}
          <EvidenceSection takedown={data.takedown} />
          <SubmissionsSection rows={data.submissions} />
        </>
      )}
    </div>
  );
}

function Header({ takedown: t }: { takedown: TakedownDetailRow }) {
  return (
    <header className="rounded-xl border border-white/[0.10] bg-bg-card p-5">
      <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Takedown · {t.target_type}</div>
      <h1 className="text-[22px] font-bold text-white tracking-tight mt-0.5 truncate font-mono">{t.target_value}</h1>

      <div className="flex items-center gap-2 flex-wrap mt-3">
        <SeverityPill level={t.severity} />
        <StatusPill status={t.status} />
        {t.module_key && <ModuleChip module_key={t.module_key} />}
        <span className="text-[10px] uppercase tracking-widest font-mono text-white/45">
          source: {t.source_type ?? 'manual'}
        </span>
        {t.priority_score > 0 && (
          <span className="text-[10px] uppercase tracking-widest font-mono text-white/45">
            priority: {t.priority_score}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-white/[0.06] text-[11px]">
        <Fact label="Brand"        value={t.brand_name ?? t.brand_id} mono />
        <Fact label="Provider"     value={t.provider_name ?? '—'} />
        <Fact label="Provider method" value={t.provider_method ?? '—'} />
        <Fact label="Submissions"  value={String(t.submission_count)} />
        <Fact label="Created"      value={formatTimestamp(t.created_at)} mono />
        <Fact label="Submitted"    value={formatTimestamp(t.submitted_at)} mono />
        <Fact label="Resolved"     value={formatTimestamp(t.resolved_at)} mono />
        <Fact label="Resolution"   value={t.resolution ?? '—'} />
      </div>

      {t.target_url && (
        <a
          href={t.target_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-amber hover:underline text-xs font-mono mt-4"
        >
          <ExternalLink size={11} /> {t.target_url}
        </a>
      )}
    </header>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest font-mono text-white/35 mb-0.5">{label}</div>
      <div className={`text-[12px] text-white/85 truncate ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function EvidenceSection({ takedown: t }: { takedown: TakedownDetailRow }) {
  if (!t.evidence_summary && !t.evidence_detail) return null;
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-mono text-white/45 mb-2">
        <FileText size={11} /> Evidence
      </div>
      <p className="text-[13px] text-white/85 leading-relaxed">{t.evidence_summary}</p>
      {t.evidence_detail && (
        <pre className="text-[11px] text-white/65 font-mono mt-3 bg-black/20 border border-white/[0.04] rounded p-3 whitespace-pre-wrap overflow-x-auto">
          {t.evidence_detail}
        </pre>
      )}
      {t.response_notes && (
        <>
          <div className="text-[10px] uppercase tracking-widest font-mono text-white/45 mt-4 mb-1">Provider response</div>
          <p className="text-[12px] text-white/65">{t.response_notes}</p>
        </>
      )}
    </section>
  );
}

function SubmissionsSection({ rows }: { rows: TakedownSubmissionAuditRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45">
        Submission audit trail <span className="text-white/30">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
          <p className="text-white/55 text-sm">No submissions recorded yet.</p>
          <p className="text-white/35 text-xs mt-1">
            Submissions land here when Sparrow auto-submits the request, or when ops sends it manually.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => <SubmissionRow key={r.id} row={r} />)}
        </div>
      )}
    </section>
  );
}

function SubmissionRow({ row: r }: { row: TakedownSubmissionAuditRow }) {
  const isFollowup = r.submitter_kind.startsWith('followup_');
  const tone =
    r.outcome === 'failed' || r.outcome === 'rejected' ? 'border-sev-critical/[0.30]' :
    r.outcome === 'submitted'                          ? 'border-green/[0.20]'        :
    isFollowup                                         ? 'border-amber/[0.20]'        :
                                                         'border-white/[0.06]';
  return (
    <article className={`rounded-xl border bg-bg-card p-4 ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <OutcomePill outcome={r.outcome} />
        <span className="inline-flex items-center text-[10px] uppercase tracking-widest font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
          {SUBMITTER_KIND_LABELS[r.submitter_kind] ?? r.submitter_kind}
        </span>
        {r.ticket_id && (
          <span className="text-[11px] font-mono text-amber/85">
            ticket: {r.ticket_id}
          </span>
        )}
      </div>

      {r.submitter_target && (
        <div className="text-[12px] text-white/65 mt-1">
          <Mail size={11} className="inline mr-1 text-white/40" />
          <span className="font-mono">{r.submitter_target}</span>
        </div>
      )}

      {r.request_summary && (
        <pre className="text-[11px] text-white/55 font-mono mt-2 bg-black/20 border border-white/[0.04] rounded p-2 whitespace-pre-wrap overflow-x-auto line-clamp-6">
          {r.request_summary}
        </pre>
      )}

      {r.error_message && (
        <p className="text-[12px] text-sev-critical mt-2">{r.error_message}</p>
      )}

      <div className="flex items-center gap-3 mt-2 text-[11px] font-mono text-white/40">
        <span>{formatTimestamp(r.attempted_at)}</span>
        {r.duration_ms !== null && <span>· {r.duration_ms}ms</span>}
        {r.response_status !== null && <span>· HTTP {r.response_status}</span>}
      </div>
    </article>
  );
}

function OutcomePill({ outcome }: { outcome: string }) {
  const tone =
    outcome === 'submitted' ? 'text-green/85   bg-green/[0.06]   border-green/[0.15]' :
    outcome === 'queued'    ? 'text-amber      bg-amber/[0.10]   border-amber/[0.20]' :
    outcome === 'rejected'
    || outcome === 'failed' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.20]' :
                              'text-white/55   bg-white/[0.04]   border-white/[0.08]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {outcome}
    </span>
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

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
