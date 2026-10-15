/** The small kind tag (`CRITICAL`, `OPERATION`, …) the headline bar and the rail rows share. */

import { KIND_LABEL, KIND_TONE, type EventKind } from '../lib/events';

export function EventChip({ kind, className = '' }: { kind: EventKind; className?: string }) {
  const tone = KIND_TONE[kind];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.12em] ${className}`}
      style={{ color: tone.fg, background: tone.bg }}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
