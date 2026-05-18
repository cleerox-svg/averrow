// Averrow Design System — useBreakpoint hook
// Single responsive breakpoint hook for the platform.
// Mobile: < 900px. Desktop: >= 900px.
// (Bumped from 768 → 900 in Audit P3 — horizontal phones in
// landscape clock 770-820, the old threshold left them with
// desktop chrome cramped into a phone viewport.)
//
// `isMobileVertical` narrows mobile further to portrait orientation
// so the slide-out sidebar drawer can replace the bottom-tab + More
// menu on phones held upright without disturbing landscape phones.

import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT     = 900;
const MOBILE_QUERY          = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
const MOBILE_VERTICAL_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px) and (orientation: portrait)`;

export function useBreakpoint() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });
  const [isMobileVertical, setIsMobileVertical] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(MOBILE_VERTICAL_QUERY).matches;
  });

  useEffect(() => {
    const mobileMql   = window.matchMedia(MOBILE_QUERY);
    const verticalMql = window.matchMedia(MOBILE_VERTICAL_QUERY);
    const onMobile    = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    const onVertical  = (e: MediaQueryListEvent) => setIsMobileVertical(e.matches);
    mobileMql.addEventListener('change', onMobile);
    verticalMql.addEventListener('change', onVertical);
    setIsMobile(mobileMql.matches);
    setIsMobileVertical(verticalMql.matches);
    return () => {
      mobileMql.removeEventListener('change', onMobile);
      verticalMql.removeEventListener('change', onVertical);
    };
  }, []);

  return {
    isMobile,
    isDesktop: !isMobile,
    isMobileVertical,
    isMobileHorizontal: isMobile && !isMobileVertical,
  };
}
