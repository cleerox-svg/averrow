/**
 * Hooks that decide whether the map animation should be running:
 * reactive prefers-reduced-motion, tab visibility, and on-screen intersection.
 */

import { useEffect, useState, type RefObject } from 'react';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function readReduced(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_QUERY).matches
    : false;
}

/** Live `prefers-reduced-motion: reduce` (re-renders if the OS setting flips while the page is open). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReduced);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(REDUCED_QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    setReduced(mql.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari < 14
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);
  return reduced;
}

/** False while the tab is hidden. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** False while `ref`'s element is scrolled/clipped fully out of view. Assumes visible where IntersectionObserver is missing. */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}
