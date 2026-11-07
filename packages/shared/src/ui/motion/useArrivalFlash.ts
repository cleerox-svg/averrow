// Arrival detection for the critical-alert move (Kinetic move 1). Returns the
// ids that ARRIVED since the previous render: never on the first render,
// never when `resetKey` changes (a new filter is not an arrival), never while
// motion is off. Each id is flagged once, for `holdMs`, so its row can carry
// the one-shot `motion-arrive` class.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMotionOn } from './motion';

const NONE: ReadonlySet<string> = new Set();
const SEP = '\u0000';

export function useArrivalFlash(ids: readonly string[], resetKey: unknown = null, holdMs = 1200): ReadonlySet<string> {
  const on = useMotionOn();
  const seen = useRef<Set<string> | null>(null);
  const lastReset = useRef<unknown>(resetKey);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(NONE);
  const sig = ids.join(SEP);

  useEffect(() => {
    const current = sig ? sig.split(SEP) : [];
    const known = seen.current;
    const baseline = known === null || lastReset.current !== resetKey || !on;
    const fresh = baseline ? [] : current.filter((id) => !known.has(id));
    const next = known ?? new Set<string>();
    for (const id of current) next.add(id);
    seen.current = next;
    lastReset.current = resetKey;
    if (fresh.length === 0) return;
    setArrived(new Set(fresh));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setArrived(NONE), holdMs);
  }, [sig, resetKey, on, holdMs]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useMemo(() => (on ? arrived : NONE), [on, arrived]);
}
