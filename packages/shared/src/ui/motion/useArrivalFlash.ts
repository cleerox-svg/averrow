// Arrival detection for the critical-alert move (Kinetic move 1). Returns the
// ids that ARRIVED since the previous render: never on the first render,
// never when `resetKey` changes (a new filter is not an arrival), never while
// motion is off. Each id is flagged once, for `holdMs`, so its row can carry
// the one-shot `motion-arrive` class.
//
// An id that is merely new to the list is not necessarily new to the world:
// it may newly qualify for a clock-based filter (an SLA window) or slide in
// under a capped list. Pass `timeOf` (created / first-seen time, ms) and only
// ids created after the previous update (less `skewMs` for server/client
// clock drift) are flagged. An id whose time is unknown (null) is flagged.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMotionOn } from './motion';

const NONE: ReadonlySet<string> = new Set();
const SEP = '\u0000';

export interface ArrivalFlashOptions {
  /** How long an id stays flagged, ms. Default 1200. */
  holdMs?: number;
  /** Created / first-seen time of an id (epoch ms), or null when unknown. */
  timeOf?: (id: string) => number | null;
  /** Allowed server/client clock drift, ms. Default 120000. */
  skewMs?: number;
}

export function useArrivalFlash(
  ids: readonly string[],
  resetKey: unknown = null,
  { holdMs = 1200, timeOf, skewMs = 120_000 }: ArrivalFlashOptions = {},
): ReadonlySet<string> {
  const on = useMotionOn();
  const seen = useRef<Set<string> | null>(null);
  const lastReset = useRef<unknown>(resetKey);
  const lastUpdateAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeOfRef = useRef(timeOf);
  timeOfRef.current = timeOf;
  const [arrived, setArrived] = useState<ReadonlySet<string>>(NONE);
  const sig = ids.join(SEP);

  useEffect(() => {
    const now = Date.now();
    const since = lastUpdateAt.current - skewMs;
    lastUpdateAt.current = now;
    const current = sig ? sig.split(SEP) : [];
    const known = seen.current;
    const baseline = known === null || lastReset.current !== resetKey || !on;
    const getTime = timeOfRef.current;
    const fresh = baseline ? [] : current.filter((id) => {
      if (known.has(id)) return false;
      const t = getTime?.(id) ?? null;
      return t === null || !Number.isFinite(t) || t > since;
    });
    const next = known ?? new Set<string>();
    for (const id of current) next.add(id);
    seen.current = next;
    lastReset.current = resetKey;
    if (fresh.length === 0) return;
    setArrived(new Set(fresh));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setArrived(NONE), holdMs);
  }, [sig, resetKey, on, holdMs, skewMs]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useMemo(() => (on ? arrived : NONE), [on, arrived]);
}
