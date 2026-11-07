// Directional page slide (Kinetic move 4): ~24px + fade when `pageKey`
// changes. `order` (e.g. the nav index) picks the direction: a lower index
// slides in from the left. Skips the first render. Reduced motion: fade only.
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { EASE_STANDARD, MOTION, fadeIn, isMotionOn, play, prefersReducedMotion } from './motion';

export function usePageSlide(
  ref: RefObject<HTMLElement | null>,
  pageKey: string,
  order: number | null = null,
  skip?: (prevKey: string, nextKey: string) => boolean,
): void {
  const prev = useRef<{ key: string; order: number | null } | null>(null);
  const latest = useRef({ order, skip });
  latest.current = { order, skip };
  useLayoutEffect(() => {
    const p = prev.current;
    const { order: nextOrder, skip: shouldSkip } = latest.current;
    prev.current = { key: pageKey, order: nextOrder };
    if (!p || p.key === pageKey || !isMotionOn() || shouldSkip?.(p.key, pageKey)) return;
    const el = ref.current;
    if (prefersReducedMotion()) { fadeIn(el); return; }
    const dir = nextOrder !== null && p.order !== null && nextOrder < p.order ? -1 : 1;
    play(el, [
      { opacity: 0, transform: `translateX(${dir * MOTION.pageTravel}px)` },
      { opacity: 1, transform: 'none' },
    ], MOTION.slow, EASE_STANDARD);
  }, [ref, pageKey]);
}
