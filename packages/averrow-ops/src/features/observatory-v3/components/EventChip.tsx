/** The small kind tag (Critical, Operation, …) the headline bar and the rail rows share: sans, sentence case, 12px. */

import { LABEL } from '../lib/chrome-classes';
import { KIND_LABEL, KIND_TONE, type EventKind } from '../lib/events';

export function EventChip({ kind, className = '' }: { kind: EventKind; className?: string }) {
  const tone = KIND_TONE[kind];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 ${LABEL} ${className}`}
      style={{ color: tone.fg, background: tone.bg }}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
