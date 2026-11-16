// Live-status chip for the Network view's control row. State is carried by
// shape and text, not colour alone. The visible text ticks once a second; the
// polite live region is separate and only changes when the state does.

import { useEffect, useState } from 'react';
import { chipModel, type ChipInput, type ChipState } from './replay';

function Shape({ state }: { state: ChipState }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false } as const;
  switch (state) {
    case 'live': // filled disc
      return <svg {...common}><circle cx="6" cy="6" r="4.5" fill="var(--healthy)" /></svg>;
    case 'paused':
    case 'motion-off': // hollow disc
      return <svg {...common}><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
    case 'reconnecting':
    case 'connecting': // dashed ring
      return <svg {...common}><circle cx="6" cy="6" r="4" fill="none" stroke="var(--sev-medium)" strokeWidth="1.6" strokeDasharray="2.2 1.8" /></svg>;
    case 'offline': // struck-through ring
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4" fill="none" stroke="var(--sev-critical)" strokeWidth="1.6" />
          <line x1="2.5" y1="9.5" x2="9.5" y2="2.5" stroke="var(--sev-critical)" strokeWidth="1.6" />
        </svg>
      );
    case 'replay': // play triangle
      return <svg {...common}><path d="M3 1.8 L10 6 L3 10.2 Z" fill="var(--primary-text)" /></svg>;
  }
}

export type LiveChipProps = Omit<ChipInput, 'now'>;

export function LiveChip(props: LiveChipProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const m = chipModel({ ...props, now });
  return (
    <>
      <span
        data-testid="live-chip"
        data-state={m.state}
        title={m.title}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded font-mono text-[11px]"
        style={{
          background: 'var(--bg-card-deep)', border: '1px solid var(--border-base)',
          color: 'var(--text-secondary)',
        }}
      >
        <Shape state={m.state} />
        <span className="tabular-nums whitespace-nowrap" style={{ display: 'inline-block', minWidth: '27ch' }}>
          {m.label}
        </span>
      </span>
      {/* Announces state changes only: its text never includes the age. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="live-chip-status">{m.announce}</span>
    </>
  );
}
