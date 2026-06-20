// Investigations / Cases — the list surface
// (TENANT_ANALYST_UX_RESEARCH_2026-06 #7). A case groups related signals,
// threats and takedowns so an analyst works a campaign as one unit rather
// than signal-by-signal. Analysts can open a new case here; everyone in
// the org can read them.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, FolderSearch, Loader2, MessageSquare, Layers } from 'lucide-react';
import {
  useInvestigations, useCreateInvestigation, INVESTIGATION_STATUS_LABELS,
  type InvestigationStatus, type InvestigationSeverity, type Investigation,
} from '@/lib/investigations';
import { useCanTriage } from '@/lib/alerts';
import { StatusPill, SeverityDot } from './pills';

type StatusFilter = InvestigationStatus | 'all';
const FILTERS: StatusFilter[] = ['all', 'open', 'monitoring', 'closed'];

export function Investigations() {
  const canEdit = useCanTriage();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useInvestigations(filter);

  const counts: Record<string, number> = {};
  for (const b of data?.status_breakdown ?? []) counts[b.status] = b.count;
  const totalAll = (data?.status_breakdown ?? []).reduce((s, b) => s + b.count, 0);

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Workspace</div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Investigations</h1>
          <p className="mt-1 text-sm text-white/55 max-w-2xl">
            Group related signals, threats and takedowns into a case — work the whole campaign as one unit, with a shared status, owner and notes timeline.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setCreating((c) => !c)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-amber/[0.14] hover:bg-amber/[0.20] text-amber border border-amber/[0.40] rounded-lg font-semibold text-sm transition-colors flex-shrink-0"
          >
            <Plus size={15} /> New investigation
          </button>
        )}
      </header>

      {creating && canEdit && <CreateForm onDone={() => setCreating(false)} />}

      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map((f) => {
          const n = f === 'all' ? totalAll : (counts[f] ?? 0);
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={[
                'px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors',
                filter === f
                  ? 'bg-amber/[0.10] text-amber border-amber/[0.30]'
                  : 'bg-white/[0.04] text-white/55 border-white/[0.08] hover:text-white/85',
              ].join(' ')}
            >
              {f === 'all' ? 'All' : INVESTIGATION_STATUS_LABELS[f]} · {n}
            </button>
          );
        })}
      </div>

      {isLoading && <div className="text-white/40 text-sm font-mono py-12 text-center">Loading…</div>}

      {!isLoading && (data?.data.length ?? 0) === 0 && (
        <section className="rounded-xl border border-white/[0.06] bg-bg-card p-10 text-center">
          <FolderSearch size={28} className="text-white/20 mx-auto mb-3" />
          <p className="text-sm text-white/70">No investigations yet.</p>
          <p className="text-[12px] text-white/40 mt-1">
            {canEdit ? 'Open one from a signal, or start a fresh case above.' : 'An analyst can open a case from a signal.'}
          </p>
        </section>
      )}

      <div className="space-y-2.5">
        {(data?.data ?? []).map((inv) => <Row key={inv.id} inv={inv} />)}
      </div>
    </div>
  );
}

function Row({ inv }: { inv: Investigation }) {
  return (
    <Link
      to={`/investigations/${inv.id}`}
      className="block rounded-xl border border-white/[0.07] bg-bg-card p-4 hover:border-white/[0.16] transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <SeverityDot severity={inv.severity} />
            <StatusPill status={inv.status} />
            <h3 className="text-[15px] font-semibold text-white/90 truncate">{inv.title}</h3>
          </div>
          {inv.description && <p className="text-[12px] text-white/50 mt-1 line-clamp-2 leading-relaxed">{inv.description}</p>}
        </div>
        <div className="text-right text-[10px] font-mono text-white/40 flex-shrink-0">
          <div>{new Date(inv.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
          {inv.assigned_to_name && <div className="mt-0.5 text-white/55 truncate max-w-[120px]">{inv.assigned_to_name}</div>}
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2.5 text-[11px] font-mono text-white/40">
        <span className="inline-flex items-center gap-1"><Layers size={11} /> {inv.item_count ?? 0} linked</span>
        <span className="inline-flex items-center gap-1"><MessageSquare size={11} /> {inv.note_count ?? 0} notes</span>
        {inv.created_by_name && <span>· opened by {inv.created_by_name}</span>}
      </div>
    </Link>
  );
}

const SEVERITIES: InvestigationSeverity[] = ['critical', 'high', 'medium', 'low'];

function CreateForm({ onDone }: { onDone: () => void }) {
  const create = useCreateInvestigation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<InvestigationSeverity>('medium');

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    create.mutate(
      { title: t, description: description.trim() || undefined, severity },
      { onSuccess: () => { setTitle(''); setDescription(''); onDone(); } },
    );
  };

  return (
    <section className="rounded-xl border border-amber/[0.18] bg-amber/[0.03] p-4 space-y-3">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Investigation title — e.g. “Q2 payroll-phish campaign”"
        autoFocus
        className="w-full bg-white/[0.04] border border-white/[0.10] rounded-md px-3 py-2 text-[14px] text-white/90 placeholder:text-white/30 focus:outline-none focus:border-amber/[0.40]"
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What ties these together? (optional)"
        rows={2}
        className="w-full bg-white/[0.04] border border-white/[0.10] rounded-md px-3 py-2 text-[12.5px] text-white/85 placeholder:text-white/30 focus:outline-none focus:border-amber/[0.40] resize-none"
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-white/45 font-mono">Priority</span>
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSeverity(s)}
              className={[
                'px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors',
                severity === s ? 'bg-amber/[0.12] text-amber border-amber/[0.35]' : 'bg-white/[0.03] text-white/45 border-white/[0.07]',
              ].join(' ')}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onDone} className="px-3 py-1.5 text-[12px] font-mono text-white/55 hover:text-white/85">Cancel</button>
          <button
            type="button"
            disabled={!title.trim() || create.isPending}
            onClick={submit}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-amber/[0.14] hover:bg-amber/[0.20] text-amber border border-amber/[0.40] rounded-lg font-semibold text-[13px] transition-colors disabled:opacity-50"
          >
            {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create
          </button>
        </div>
      </div>
      {create.isError && <p className="text-[11px] text-sev-critical">{create.error instanceof Error ? create.error.message : 'Create failed'}</p>}
    </section>
  );
}
