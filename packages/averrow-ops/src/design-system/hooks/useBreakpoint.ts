// Averrow Design System — useBreakpoint hook
// Single responsive breakpoint hook for the platform.
// Mobile: < 900px. Desktop: >= 900px.
// (Bumped from 768 → 900 in Audit P3 — horizontal phones in
// landscape clock 770-820, the old threshold left them with
// desktop chrome cramped into a phone viewport.)

import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 900;

export function useBreakpoint() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return {
    isMobile,
    isDesktop: !isMobile,
  };
}
