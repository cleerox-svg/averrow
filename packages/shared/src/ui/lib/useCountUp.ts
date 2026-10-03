import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

/**
 * Eased count to `target`. The first mount animates from 0; later target
 * changes (e.g. a 30s KPI refetch) animate from the last displayed value so
 * the number never snaps back to 0. Under reduced motion (or a non-finite /
 * zero target) the final value is applied immediately, with no animation
 * frames scheduled.
 */
export function useCountUp(target: number, duration = 1100): number {
  const reduced = useReducedMotion();
  const [val, setVal] = useState(0);
  // Last value actually shown; the start point of the next animation.
  const shown = useRef(0);

  useEffect(() => {
    if (reduced || !Number.isFinite(target) || target === 0) {
      shown.current = Number.isFinite(target) ? target : 0;
      setVal(target);
      return;
    }
    const from = shown.current;
    if (from === target) return;
    let raf = 0;
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      const next = Math.round(from + ease * (target - from));
      shown.current = next;
      setVal(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);

  // Return the target directly on the first reduced-motion render so there
  // is no one-frame flash of 0 before the effect runs.
  return reduced ? target : val;
}
