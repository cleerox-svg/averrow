import { useState, useEffect } from 'react';

export function useBreakpoint() {
  const [width, setWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1024
  );

  useEffect(() => {
    const handler = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return {
    // Audit P3: bumped from 768 → 900 so horizontal phones
    // (~770-820 landscape) get the mobile shell + drawer chrome
    // instead of cramming desktop sidebar + docked panel into the
    // viewport. Observatory's mobile branch already implements
    // drawer-style panel behavior (mobile tab bar above ticker).
    isMobile: width < 900,
    isTablet: width >= 900 && width < 1024,
    isDesktop: width >= 1024,
    isWide: width >= 1440,
    width,
  };
}
