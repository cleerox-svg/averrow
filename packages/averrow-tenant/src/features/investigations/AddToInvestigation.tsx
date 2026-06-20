// "Add to investigation" — the link-out from a signal (or any item) into
// a case. Mounted on the Intelligence Card right rail. Analyst+ only.
// Lets the analyst attach the item to an existing open case or spin up a
// fresh one seeded with this item.

import { useState } from 'react';
import { FolderPlus, Plus, Check, Loader2 } from 'lucide-react';
import {
  useInvestigations, useLinkToInvestigation, useCreateInvestigation,
  type InvestigationItemType,
} from '@/lib/investigations';
import { useCanTriage } from '@/lib/alerts';

export function AddToInvestigation({ itemType, itemId, defaultTitle }: {
  itemType: InvestigationItemType; itemId: string; defaultTitle?: string;
}) {
  const canEdit = useCanTriage();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [done, setDone] = useState<string | null>(null);

  const { data } = useInvestigations();
  const link = useLinkToInvestigation();
  const create = useCreateInvestigation();

  if (!canEdit) return null;

  const cases = (data?.data ?? []).filter((c) => c.status !== 'closed');

  const linkTo = (investigationId: string, label: string) => {
    link.mutate({ investigationId, item_type: itemType, item_id: itemId }, {
      onSuccess: () => { setDone(label); setOpen(false); },
    });
  };

  const createAndLink = () => {
    const t = title.trim();
    if (!t) return;
    create.mutate(
      { title: t, items: [{ item_type: itemType, item_id: itemId }] },
      { onSuccess: () => { setDone(t); setOpen(false); setMode('pick'); } },
    );
  };

  if (done) {
    return (
      <div className="text-[11px] font-mono text-green/80 flex items-center gap-1.5">
        <Check size={12} /> Added to “{done}”.
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-mono text-white/65 bg-white/[0.04] border border-white/[0.08] hover:text-white/95 hover:border-white/[0.18] transition-colors"
      >
        <FolderPlus size={13} /> Add to investigation
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.10] bg-white/[0.02] p-2.5 space-y-2">
      {mode === 'pick' ? (
        <>
          <div className="max-h-44 overflow-y-auto space-y-1">
            {cases.length === 0 && <p className="text-[11px] text-white/35 px-1 py-1.5">No open cases.</p>}
            {cases.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={link.isPending}
                onClick={() => linkTo(c.id, c.title)}
                className="w-full text-left px-2 py-1.5 rounded-md text-[12px] text-white/75 hover:bg-white/[0.05] disabled:opacity-50 truncate"
              >
                {c.title}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-white/[0.06]">
            <button type="button" onClick={() => setMode('new')} className="inline-flex items-center gap-1 text-[11px] font-mono text-amber/80 hover:text-amber">
              <Plus size={11} /> New case
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-[11px] font-mono text-white/45 hover:text-white/70">Cancel</button>
          </div>
          {link.isPending && <Loader2 size={12} className="animate-spin text-white/40" />}
          {link.isError && <p className="text-[11px] text-sev-critical">{link.error instanceof Error ? link.error.message : 'Failed to add'}</p>}
        </>
      ) : (
        <>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New investigation title…"
            autoFocus
            className="w-full bg-white/[0.04] border border-white/[0.10] rounded-md px-2.5 py-1.5 text-[12px] text-white/85 placeholder:text-white/30 focus:outline-none focus:border-amber/[0.40]"
            onKeyDown={(e) => { if (e.key === 'Enter') createAndLink(); }}
          />
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => setMode('pick')} className="text-[11px] font-mono text-white/45 hover:text-white/70">Back</button>
            <button
              type="button"
              disabled={!title.trim() || create.isPending}
              onClick={createAndLink}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-amber/[0.14] text-amber border border-amber/[0.40] hover:bg-amber/[0.20] disabled:opacity-50"
            >
              {create.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create & add
            </button>
          </div>
          {create.isError && <p className="text-[11px] text-sev-critical">{create.error instanceof Error ? create.error.message : 'Failed to create'}</p>}
        </>
      )}
    </div>
  );
}
