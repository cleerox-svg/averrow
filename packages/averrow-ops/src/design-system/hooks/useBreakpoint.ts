// Averrow Design System — useBreakpoint hook
// Single responsive breakpoint hook for the platform.
// Mobile: < 768px. Desktop: >= 768px.

import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;

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
