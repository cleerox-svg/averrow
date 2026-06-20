// Investigation detail — the case workspace
// (TENANT_ANALYST_UX_RESEARCH_2026-06 #7). Shows the linked items
// (signals / threats / takedowns), a notes timeline, and the case
// controls: status (open → monitoring → closed), priority, and owner.
// Analysts edit; viewers read. Deep-linkable at /investigations/:id.

import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Radar, ShieldAlert, Send, X, Loader2, MessageSquare,
  UserPlus, UserCheck, Trash2, type LucideIcon,
} from 'lucide-react';
import {
  useInvestigation, useUpdateInvestigation, useAddInvestigationNote,
  useRemoveInvestigationItem,
  INVESTIGATION_STATUS_LABELS,
  type InvestigationStatus, type InvestigationSeverity, type InvestigationItem,
  type InvestigationNote,
} from '@/lib/investigations';
import { useCanTriage } from '@/lib/alerts';
import { useAuth } from '@/lib/auth';
import { StatusPill, SeverityDot } from './pills';

const STATUSES: InvestigationStatus[] = ['open', 'monitoring', 'closed'];
const SEVERITIES: InvestigationSeverity[] = ['critical', 'high', 'medium', 'low'];

export function InvestigationDetail() {
  const { investigationId } = useParams<{ investigationId: string }>();
  const canEdit = useCanTriage();
  const { user } = useAuth();
  const { data: inv, isLoading, error } = useInvestigation(investigationId);
  const update = useUpdateInvestigation(investigationId ?? '');

  if (isLoading) return <div className="text-white/40 text-sm font-mono py-16 text-center">Loading case…</div>;
  if (error || !inv) {
    return (
      <div className="max-w-2xl">
        <Back />
        <section className="mt-4 rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-6">
          <p className="text-sm text-white/70">{error instanceof Error ? error.message : 'Investigation not found.'}</p>
        </section>
      </div>
    );
  }

  const me = user?.id ?? null;
  const assignedToMe = !!inv.assigned_to && inv.assigned_to === me;

  return (
    <div className="max-w-4xl space-y-5">
      <Back />

      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <SeverityDot severity={inv.severity} />
          <StatusPill status={inv.status} />
          {inv.assigned_to_name && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
              <UserCheck size={10} /> {assignedToMe ? 'You' : inv.assigned_to_name}
            </span>
          )}
        </div>
        <h1 className="text-[22px] font-bold text-white tracking-tight mt-2 leading-snug">{inv.title}</h1>
        {inv.description && <p className="text-[13px] text-white/60 mt-1 leading-relaxed">{inv.description}</p>}
        <div className="mt-1 text-[11px] font-mono text-white/40">
          opened {new Date(inv.created_at).toLocaleString()}{inv.created_by_name ? ` · by ${inv.created_by_name}` : ''}
          {inv.closed_at ? ` · closed ${new Date(inv.closed_at).toLocaleDateString()}` : ''}
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-5 items-start">
        {/* Main */}
        <div className="min-w-0 space-y-4">
          <LinkedItems items={inv.items} canEdit={canEdit} investigationId={inv.id} />
          <Notes investigationId={inv.id} notes={inv.notes} canEdit={canEdit} />
        </div>

        {/* Controls rail */}
        <aside className="space-y-4 lg:sticky lg:top-4">
          <section className="rounded-xl border border-white/[0.07] bg-bg-card p-4 space-y-4">
            <div>
              <Label>Status</Label>
              <div className="flex flex-col gap-1">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!canEdit || update.isPending}
                    onClick={() => inv.status !== s && update.mutate({ status: s })}
                    className={[
                      'text-left px-2.5 py-1.5 rounded-md text-[12px] border transition-colors disabled:opacity-60',
                      inv.status === s ? 'bg-amber/[0.10] text-amber border-amber/[0.30]' : 'bg-white/[0.03] text-white/60 border-white/[0.07] hover:text-white/90',
                    ].join(' ')}
                  >
                    {INVESTIGATION_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Priority</Label>
              <div className="flex items-center gap-1.5 flex-wrap">
                {SEVERITIES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!canEdit || update.isPending}
                    onClick={() => inv.severity !== s && update.mutate({ severity: s })}
                    className={[
                      'px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-60',
                      inv.severity === s ? 'bg-amber/[0.12] text-amber border-amber/[0.35]' : 'bg-white/[0.03] text-white/45 border-white/[0.07]',
                    ].join(' ')}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Label>Owner</Label>
              {canEdit ? (
                assignedToMe ? (
                  <button
                    type="button"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ assigned_to: null })}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-mono text-white/55 bg-white/[0.04] border border-white/[0.08] hover:text-white/85"
                  >
                    <X size={11} /> Unassign
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={update.isPending || !me}
                    onClick={() => me && update.mutate({ assigned_to: me })}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-mono text-white/60 bg-white/[0.04] border border-white/[0.08] hover:text-white/90"
                  >
                    <UserPlus size={11} /> {inv.assigned_to_name ? 'Reassign to me' : 'Assign to me'}
                  </button>
                )
              ) : (
                <p className="text-[11px] text-white/45 font-mono">{inv.assigned_to_name ?? 'Unassigned'}</p>
              )}
            </div>

            {update.isError && <p className="text-[11px] text-sev-critical">{update.error instanceof Error ? update.error.message : 'Update failed'}</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}

// ─── Linked items ────────────────────────────────────────────

const ITEM_ICON: Record<string, LucideIcon> = { alert: Radar, threat: ShieldAlert, takedown: Send };

function LinkedItems({ items, canEdit, investigationId }: {
  items: InvestigationItem[]; canEdit: boolean; investigationId: string;
}) {
  const remove = useRemoveInvestigationItem(investigationId);
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <h3 className="text-sm font-semibold text-white/90">Linked items <span className="text-white/40 font-normal">· {items.length}</span></h3>
      <p className="text-[12px] text-white/45 mt-0.5 mb-3">Signals, threats and takedowns grouped into this case. Add a signal from its Intelligence Card.</p>
      {items.length === 0 ? (
        <p className="text-[12px] text-white/35">Nothing linked yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => {
            const Icon = ITEM_ICON[it.item_type] ?? Radar;
            const to = itemHref(it);
            const inner = (
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <Icon size={14} className="text-white/45 flex-shrink-0" />
                <SeverityDot severity={it.severity} />
                <span className="text-[12.5px] text-white/80 truncate">{it.label ?? it.item_id}</span>
                {it.item_status && <span className="text-[10px] font-mono text-white/35 uppercase tracking-wider flex-shrink-0">{it.item_status.replace(/_/g, ' ')}</span>}
              </div>
            );
            return (
              <li key={it.id} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                {to ? <Link to={to} className="contents hover:opacity-90">{inner}</Link> : inner}
                <span className="text-[9px] uppercase tracking-wider font-mono text-white/30 flex-shrink-0">{it.item_type}</span>
                {canEdit && (
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(it.id)}
                    className="text-white/30 hover:text-sev-critical transition-colors flex-shrink-0"
                    aria-label="Remove from case"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function itemHref(it: InvestigationItem): string | null {
  if (it.item_type === 'alert') return `/alerts/${it.item_id}`;
  if (it.item_type === 'takedown') return `/takedowns/${it.item_id}`;
  return null; // threats have no single-record tenant page
}

// ─── Notes timeline ──────────────────────────────────────────

function Notes({ investigationId, notes, canEdit }: {
  investigationId: string; notes: InvestigationNote[]; canEdit: boolean;
}) {
  const add = useAddInvestigationNote(investigationId);
  const [draft, setDraft] = useState('');
  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    add.mutate(t, { onSuccess: () => setDraft('') });
  };
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <h3 className="text-sm font-semibold text-white/90 flex items-center gap-1.5">
        <MessageSquare size={14} className="text-white/45" /> Notes <span className="text-white/40 font-normal">· {notes.length}</span>
      </h3>

      {canEdit && (
        <div className="mt-3 flex items-start gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note to the case timeline…"
            rows={2}
            className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded-md px-2.5 py-2 text-[12.5px] text-white/85 placeholder:text-white/30 focus:outline-none focus:border-amber/[0.40] resize-none"
          />
          <button
            type="button"
            disabled={!draft.trim() || add.isPending}
            onClick={submit}
            className="px-3 py-2 rounded-md text-[12px] font-semibold bg-amber/[0.14] text-amber border border-amber/[0.40] hover:bg-amber/[0.20] disabled:opacity-50"
          >
            {add.isPending ? <Loader2 size={13} className="animate-spin" /> : 'Add'}
          </button>
        </div>
      )}

      {notes.length === 0 ? (
        <p className="text-[12px] text-white/35 mt-3">No notes yet.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="flex gap-3">
              <div className="mt-1 w-1.5 h-1.5 rounded-full bg-amber/70 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[12.5px] text-white/80 whitespace-pre-wrap break-words">{n.body}</div>
                <div className="text-[10px] font-mono text-white/40 mt-0.5">
                  {n.author_name ?? 'Unknown'} · {new Date(n.created_at).toLocaleString()}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {add.isError && <p className="mt-2 text-[11px] text-sev-critical">{add.error instanceof Error ? add.error.message : 'Failed to add note'}</p>}
    </section>
  );
}

// ─── small parts ─────────────────────────────────────────────

function Back() {
  return (
    <Link to="/investigations" className="inline-flex items-center gap-1.5 text-[12px] font-mono text-white/50 hover:text-white/85 transition-colors">
      <ArrowLeft size={14} /> Investigations
    </Link>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[9px] uppercase tracking-[0.18em] font-mono text-white/40 mb-1.5">{children}</div>;
}
