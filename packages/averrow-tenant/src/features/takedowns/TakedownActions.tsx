// Analyst approve / reject controls for a takedown request — shared by the
// queue (Takedowns list rows) and the detail page. Approving transitions a
// draft to `requested` (handing it to the submission pipeline); rejecting
// transitions it to `withdrawn`. Both reveal an optional note before
// confirming, since approving submits a real request to a provider.
//
// Gated by the caller (analyst+ org role via useCanTriage); this component
// assumes the user is already permitted and `actions` is non-empty.

import { useState } from 'react';
import { ShieldCheck, Ban, Loader2, type LucideIcon } from 'lucide-react';
import { useUpdateTakedown, type TakedownAction } from '@/lib/takedowns';

const ACTION_META: Record<TakedownAction, { label: string; verb: string; icon: LucideIcon; primary: boolean }> = {
  requested: { label: 'Approve & request', verb: 'approve', icon: ShieldCheck, primary: true  },
  withdrawn: { label: 'Withdraw',          verb: 'withdraw', icon: Ban,         primary: false },
};

export function TakedownActions({
  takedownId, actions, className,
}: {
  takedownId: string;
  actions: TakedownAction[];
  className?: string;
}) {
  const update = useUpdateTakedown();
  const [pending, setPending] = useState<TakedownAction | null>(null);
  const [note, setNote] = useState('');

  const run = (status: TakedownAction, notes?: string) => {
    update.mutate(
      { takedownId, status, notes },
      { onSuccess: () => { setPending(null); setNote(''); } },
    );
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5 flex-wrap">
        {actions.map((status) => {
          const { label, icon: Icon, primary } = ACTION_META[status];
          const active = pending === status;
          return (
            <button
              key={status}
              type="button"
              disabled={update.isPending}
              onClick={() => setPending((cur) => (cur === status ? null : status))}
              className={[
                'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-50',
                active
                  ? 'bg-amber/[0.14] text-amber border-amber/[0.40]'
                  : primary
                    ? 'bg-amber/[0.08] text-amber/90 border-amber/[0.25] hover:bg-amber/[0.14]'
                    : 'bg-white/[0.04] text-white/60 border-white/[0.08] hover:text-white/90 hover:border-white/[0.18]',
              ].join(' ')}
            >
              <Icon size={11} />{label}
            </button>
          );
        })}
        {update.isPending && <Loader2 size={12} className="text-white/40 animate-spin ml-0.5" />}
      </div>

      {pending && (
        <div className="mt-2.5 flex items-start gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Note (optional) — ${ACTION_META[pending].verb} this request`}
            className="flex-1 bg-white/[0.04] border border-white/[0.10] rounded-md px-2.5 py-1.5 text-[12px] text-white/85 placeholder:text-white/30 focus:outline-none focus:border-amber/[0.40]"
            onKeyDown={(e) => { if (e.key === 'Enter') run(pending, note.trim() || undefined); }}
            autoFocus
          />
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => run(pending, note.trim() || undefined)}
            className="px-3 py-1.5 rounded-md text-[10px] font-mono uppercase tracking-wider border bg-amber/[0.14] text-amber border-amber/[0.40] hover:bg-amber/[0.20] disabled:opacity-50 whitespace-nowrap"
          >
            Confirm {ACTION_META[pending].verb}
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
