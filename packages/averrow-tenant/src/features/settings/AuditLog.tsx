// Audit Log — tenant-facing who/what/when of automation + human actions on
// the org (TENANT_ANALYST_UX_RESEARCH_2026-06 §5.5). Read-only; analyst+.

import { useState } from 'react';
import { ScrollText, Bot, User } from 'lucide-react';
import {
  useTenantAuditLog, useCanViewAudit, auditActionLabel, auditSummary,
  type AuditEntry,
} from '@/lib/auditLog';

const PAGE_SIZE = 50;

export function AuditLog() {
  const canView = useCanViewAudit();
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useTenantAuditLog({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Account</div>
        <h1 className="text-[24px] font-bold text-white tracking-tight">Audit Log</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          Every automation and human action on your organization — signal triage, takedown decisions, authorization changes, and membership — with who did it and when.
        </p>
      </header>

      {!canView && (
        <section className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
          <p className="text-sm text-white/70">The audit log is available to analysts and above.</p>
        </section>
      )}

      {canView && (
        <>
          {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading…</div>}
          {error && (
            <section className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-5">
              <h2 className="text-sm font-semibold text-white/90">Couldn't load the audit log</h2>
              <p className="text-[12px] text-white/55 mt-1">{error instanceof Error ? error.message : 'Unknown error'}</p>
            </section>
          )}

          {data && (data.entries.length === 0 ? (
            <section className="rounded-xl border border-white/[0.06] bg-bg-card p-8 text-center">
              <ScrollText size={26} className="mx-auto text-white/30 mb-2" />
              <p className="text-sm text-white/70">No recorded actions yet.</p>
              <p className="text-[11px] text-white/40 mt-1">Actions on your org will appear here as they happen.</p>
            </section>
          ) : (
            <section className="rounded-xl border border-white/[0.06] bg-bg-card divide-y divide-white/[0.05]">
              {data.entries.map((e) => <Entry key={e.id} entry={e} />)}
            </section>
          ))}

          {data && data.total > PAGE_SIZE && (
            <Pager page={page} pageSize={PAGE_SIZE} shown={data.entries.length} total={data.total} onPage={setPage} />
          )}
        </>
      )}
    </div>
  );
}

// Actor 'System' / no actor = automation; a name = a human.
function Entry({ entry: e }: { entry: AuditEntry }) {
  const isAuto = !e.actor;
  const summary = auditSummary(e);
  const denied = e.outcome === 'denied' || e.outcome === 'failure';
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className={`mt-0.5 rounded-md border p-1.5 ${isAuto ? 'border-blue/[0.20] bg-blue/[0.06] text-blue/85' : 'border-white/[0.08] bg-white/[0.04] text-white/60'}`}>
        {isAuto ? <Bot size={13} /> : <User size={13} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] text-white/90 font-medium">{auditActionLabel(e.action)}</span>
          {summary && <span className="text-[12px] text-white/55 font-mono truncate">{summary}</span>}
          {denied && (
            <span className="text-[9px] uppercase tracking-widest font-mono text-sev-critical bg-sev-critical/[0.10] border border-sev-critical/[0.20] rounded px-1.5 py-0.5">
              {e.outcome}
            </span>
          )}
        </div>
        <div className="text-[11px] text-white/40 mt-0.5 font-mono">
          {e.actor ?? 'Automation'}{e.resource_type ? ` · ${e.resource_type.replace(/_/g, ' ')}` : ''} · {formatTimestamp(e.timestamp)}
        </div>
      </div>
    </div>
  );
}

function Pager({
  page, pageSize, shown, total, onPage,
}: {
  page: number; pageSize: number; shown: number; total: number; onPage: (p: number) => void;
}) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = page * pageSize + shown;
  const btn = 'px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-40 disabled:cursor-default bg-white/[0.04] text-white/60 border-white/[0.08] enabled:hover:text-white/90 enabled:hover:border-white/[0.18]';
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-white/40 font-mono">showing {start}–{end} of {total}</span>
      <div className="flex items-center gap-1.5">
        <button type="button" className={btn} disabled={page === 0} onClick={() => onPage(page - 1)}>Prev</button>
        <button type="button" className={btn} disabled={end >= total} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

function formatTimestamp(ts: string): string {
  // Audit timestamps are 'YYYY-MM-DD HH:MM:SS' (UTC); make it parseable.
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
