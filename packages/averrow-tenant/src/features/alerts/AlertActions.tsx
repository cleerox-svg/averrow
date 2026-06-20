// Inline signal triage controls (analyst+), shared by the Signals queue and
// the Console. Acknowledge / Investigate fire immediately; the terminal
// actions (Resolve / False positive) reveal an optional disposition note
// before confirming. Driven by PATCH /api/orgs/:orgId/alerts/:alertId.

import { useState } from 'react';
import { Check, Eye, ShieldCheck, Ban, Loader2, type LucideIcon } from 'lucide-react';
import { useUpdateAlert, type Alert, type AlertAction, type AlertStatus } from '@/lib/alerts';
import { cn } from '@/lib/cn';

// Valid next transitions per current status — mirrors the backend's accepted
// statuses; 'new' is the system default and not a transition target.
const NEXT_ACTIONS: Record<AlertStatus, AlertAction[]> = {
  new:            ['acknowledged', 'investigating', 'resolved', 'false_positive'],
  acknowledged:   ['investigating', 'resolved', 'false_positive'],
  investigating:  ['resolved', 'false_positive'],
  resolved:       [],
  false_positive: [],
};

const ACTION_META: Record<AlertAction, { label: string; icon: LucideIcon; terminal: boolean }> = {
  acknowledged:   { label: 'Acknowledge',    icon: Check,       terminal: false },
  investigating:  { label: 'Investigate',    icon: Eye,         terminal: false },
  resolved:       { label: 'Resolve',        icon: ShieldCheck, terminal: true  },
  false_positive: { label: 'False positive', icon: Ban,         terminal: true  },
};

export function AlertActions({ alert: a }: { alert: Alert }) {
  const update = useUpdateAlert();
  const [pendingTerminal, setPendingTerminal] = useState<AlertAction | null>(null);
  const [note, setNote] = useState('');

  const actions = NEXT_ACTIONS[a.status] ?? [];
  if (actions.length === 0) {
    return (
      <div className="mt-3 pt-2.5 border-t border-white/[0.06] text-[10px] font-mono uppercase tracking-widest text-white/30">
        {a.status.replace(/_/g, ' ')}
        {a.resolution_notes && <span className="ml-2 normal-case tracking-normal text-white/45">· {a.resolution_notes}</span>}
      </div>
    );
  }

  const run = (status: AlertAction, notes?: string) => {
    update.mutate(
      { alertId: a.id, status, notes },
      { onSuccess: () => { setPendingTerminal(null); setNote(''); } },
    );
  };

  const onClick = (status: AlertAction) => {
    if (ACTION_META[status].terminal) {
      setPendingTerminal((cur) => (cur === status ? null : status));
    } else {
      run(status);
    }
  };

  return (
    <div className="mt-3 pt-2.5 border-t border-white/[0.06]">
      <div className="flex items-center gap-1.5 flex-wrap">
        {actions.map((status) => {
          const { label, icon: Icon } = ACTION_META[status];
          const active = pendingTerminal === status;
          return (
            <button
              key={status}
              type="button"
              disabled={update.isPending}
              onClick={() => onClick(status)}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-50',
                active
                  ? 'bg-amber/[0.12] text-amber border-amber/[0.35]'
                  : 'bg-white/[0.04] text-white/60 border-white/[0.08] hover:text-white/90 hover:border-white/[0.18]',
              )}
            >
              <Icon size={11} />{label}
            </button>
          );
        })}
        {update.isPending && <Loader2 size={12} className="text-white/40 animate-spin ml-0.5" />}
      </div>

      {pendingTerminal && (
        <div className="mt-2.5 flex items-start gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Disposition note (optional) — ${ACTION_META[pendingTerminal].label.toLowerCase()}`}
            className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded-md px-2.5 py-1.5 text-[12px] text-white/85 placeholder:text-white/30 focus:outline-none focus:border-amber/[0.40]"
            onKeyDown={(e) => { if (e.key === 'Enter') run(pendingTerminal, note.trim() || undefined); }}
            autoFocus
          />
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => run(pendingTerminal, note.trim() || undefined)}
            className="px-3 py-1.5 rounded-md text-[10px] font-mono uppercase tracking-wider border bg-amber/[0.12] text-amber border-amber/[0.35] hover:bg-amber/[0.18] disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      )}

      {update.isError && (
        <p className="mt-2 text-[11px] text-sev-critical">
          {update.error instanceof Error ? update.error.message : 'Action failed'}
        </p>
      )}
    </div>
  );
}
